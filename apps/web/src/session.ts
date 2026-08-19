import type { TokenResponse } from "@comamessenger/core";

type SessionMessage =
  | { type: "tokens"; tokens: TokenResponse }
  | { type: "logout" };

type SessionListener = (message: SessionMessage) => void;

export interface SessionChannel {
  onmessage: ((event: MessageEvent<SessionMessage>) => void) | null;
  postMessage(message: SessionMessage): void;
  close(): void;
}

export interface SessionLocks {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

export class BrowserSessionCoordinator {
  private latestTokens: TokenResponse | null = null;
  private revision = 0;
  private readonly listeners = new Set<SessionListener>();

  constructor(
    private readonly channel: SessionChannel = new BroadcastChannel(
      "coma-session",
    ),
    private readonly locks: SessionLocks | undefined = navigator.locks,
  ) {
    this.channel.onmessage = (event) => this.receive(event.data);
  }

  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publishTokens(tokens: TokenResponse): void {
    const message = { type: "tokens", tokens } as const;
    this.receive(message);
    this.channel.postMessage(message);
  }

  publishLogout(): void {
    const message = { type: "logout" } as const;
    this.receive(message);
    this.channel.postMessage(message);
  }

  async refresh(request: () => Promise<TokenResponse>): Promise<TokenResponse> {
    const observedRevision = this.revision;
    const guardedRefresh = async () => {
      // A tab waiting for the lock must get a chance to receive the token
      // published by the previous lock holder before rotating the cookie again.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (this.revision > observedRevision && this.latestTokens)
        return this.latestTokens;
      const tokens = await request();
      this.publishTokens(tokens);
      return tokens;
    };
    return this.locks
      ? this.locks.request("coma-refresh-token", guardedRefresh)
      : guardedRefresh();
  }

  close(): void {
    this.listeners.clear();
    this.channel.close();
  }

  private receive(message: SessionMessage): void {
    if (message.type === "tokens") {
      this.latestTokens = message.tokens;
      this.revision += 1;
    } else {
      this.latestTokens = null;
    }
    for (const listener of this.listeners) listener(message);
  }
}
