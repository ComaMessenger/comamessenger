import type { MessengerAPI } from "@comamessenger/core";

export class AvatarObjectURLs {
  private readonly entries = new Map<string, Promise<string>>();
  private readonly resolved = new Map<string, string>();

  constructor(private readonly api: MessengerAPI) {}

  get(actorID: string, version: number): Promise<string> {
    const key = `${actorID}:${version}`;
    const existing = this.entries.get(key);
    if (existing) return existing;
    for (const cached of [...this.entries.keys()]) {
      if (cached.startsWith(`${actorID}:`) && cached !== key)
        this.revoke(cached);
    }
    let pending: Promise<string>;
    pending = this.api.actorAvatar(actorID).then((blob) => {
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
