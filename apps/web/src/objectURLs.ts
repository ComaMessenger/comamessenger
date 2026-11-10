import type { MessengerAPI } from "@comamessenger/core";

export type AvatarOwner = "actor" | "chat";

export class AvatarObjectURLs {
  private readonly entries = new Map<string, Promise<string>>();
  private readonly resolved = new Map<string, string>();

  constructor(private readonly api: MessengerAPI) {}

  /** Object URL of an actor avatar or a chat image; older versions are revoked. */
  get(id: string, version: number, owner: AvatarOwner = "actor"): Promise<string> {
    const prefix = `${owner}:${id}:`;
    const key = `${prefix}${version}`;
    const existing = this.entries.get(key);
    if (existing) return existing;
    for (const cached of [...this.entries.keys()]) {
      if (cached.startsWith(prefix) && cached !== key) this.revoke(cached);
    }
    let pending: Promise<string>;
    pending = (
      owner === "chat" ? this.api.chatAvatar(id) : this.api.actorAvatar(id)
    ).then((blob) => {
      const url = URL.createObjectURL(blob);
      if (this.entries.get(key) !== pending) {
        URL.revokeObjectURL(url);
        return url;
      }
      this.resolved.set(key, url);
      return url;
    });
    this.entries.set(key, pending);
    pending.catch(() => this.entries.delete(key));
    return pending;
  }

  dispose(): void {
    for (const key of [...this.entries.keys()]) this.revoke(key);
  }

  private revoke(key: string): void {
    const url = this.resolved.get(key);
    if (url) URL.revokeObjectURL(url);
    this.resolved.delete(key);
    this.entries.delete(key);
  }
}
