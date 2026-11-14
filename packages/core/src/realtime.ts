import { APIError, type MessengerAPI } from "./api";
import type { DurableEvent, RealtimeState } from "./types";
import type { TypingAction } from "./presenceText";

/** How often a connected client confirms it is still here (TTL is 60s). */
export const presenceRefreshMs = 25_000;
export interface CheckpointStorage {
  get(): Promise<number>;
  set(value: number): Promise<void>;
  clear(): Promise<void>;
}
type SocketLike = {
  readyState: number;
  send(value: string): void;
  close(): void;
  onopen: ((event: any) => void) | null;
  onmessage: ((event: any) => void) | null;
  onclose: ((event: any) => void) | null;
};
export type SocketFactory = (url: string) => SocketLike;
export class RealtimeCoordinator {
  private socket: SocketLike | null = null;
  private stopped = true;
  private reconnectAttempt = 0;
  private passwordChangeRequired = false;
  private ackTimer: ReturnType<typeof setTimeout> | null = null;
  private lastAck = 0;
  private ackInterval = 1000;
  private ackBatch = 50;
  private active = {
    chatID: null as string | null,
    threadRootID: null as string | null,
  };
  /** Optional protocol additions the server announced in hello. */
  private features = new Set<string>();
  private presenceState: "active" | "away" | null = null;
  private presenceTimer: ReturnType<typeof setInterval> | null = null;
  constructor(
    private readonly api: MessengerAPI,
    private readonly storage: CheckpointStorage,
    private readonly sockets: SocketFactory,
    private readonly callbacks: {
      state(value: RealtimeState): void;
      event(value: DurableEvent): boolean;
      resync(highWatermark: number): Promise<void>;
      typing?(value: Record<string, unknown>): void;
      presence?(value: Record<string, unknown>): void;
      presenceSnapshot?(value: Record<string, unknown>): void;
      agentStatus?(value: Record<string, unknown>): void;
      messageStreaming?(value: Record<string, unknown>): void;
      ephemeralReset?(): void;
      passwordChangeRequired?(): void;
      sessionExpired?(): void;
    },
  ) {}
  start(): void {
    this.stopped = false;
    void this.connect(false);
  }
  stop(): void {
    this.stopped = true;
    this.socket?.close();
    if (this.ackTimer) clearTimeout(this.ackTimer);
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.presenceTimer = null;
    this.callbacks.ephemeralReset?.();
    this.callbacks.state("idle");
  }
  subscribe(chatID: string | null, threadRootID: string | null = null): void {
    this.active = { chatID, threadRootID };
    this.send({
      op: "subscribe_active",
      chat_id: chatID,
      thread_root_id: threadRootID,
    });
  }
  typing(
    chatID: string,
    active: boolean,
    threadRootID: string | null = null,
    action: TypingAction = "typing",
  ): void {
    this.send({
      op: "typing",
      chat_id: chatID,
      thread_root_id: threadRootID,
      active,
      // Servers before the field reject unknown keys and close the socket;
      // without it the action reads as typing, which is the safe fallback.
      ...(action !== "typing" && this.features.has("typing_actions")
        ? { action }
        : {}),
    });
  }
  /**
   * Foreground or background. The coordinator repeats the state after every
   * (re)connect and every presenceRefreshMs, so the server knows the client
   * is still there; leaving is noticed when the socket closes.
   */
  presence(state: "active" | "away"): void {
    this.presenceState = state;
    this.send({ op: "presence", state });
    if (!this.presenceTimer)
      this.presenceTimer = setInterval(() => {
        if (this.presenceState)
          this.send({ op: "presence", state: this.presenceState });
      }, presenceRefreshMs);
  }
  private async connect(reconnect: boolean): Promise<void> {
    if (this.stopped) return;
    this.callbacks.state(reconnect ? "reconnecting" : "connecting");
    try {
      if (!this.api.token()) await this.api.refresh();
      const checkpoint = await this.storage.get();
      const socket = this.sockets(this.api.websocketURL());
      const socketToken = this.api.token();
      this.passwordChangeRequired = false;
      this.socket = socket;
      socket.onopen = () => {
        this.callbacks.state("authenticating");
        socket.send(
          JSON.stringify({
            op: "auth",
            request_id: crypto.randomUUID(),
            access_token: this.api.token(),
            last_seq: checkpoint,
          }),
        );
      };
      socket.onmessage = (raw) => void this.receive(raw.data);
      socket.onclose = (event) => {
        this.callbacks.ephemeralReset?.();
        if (this.stopped) return;
        if (event.code === 4001) {
          if (this.passwordChangeRequired) return;
          void this.reauthenticate(socketToken);
          return;
        }
        const delay =
          Math.min(30000, 500 * 2 ** this.reconnectAttempt++) +
          Math.random() * 350;
        setTimeout(() => void this.connect(true), delay);
      };
    } catch (cause) {
      if (this.stopped) return;
      // A rejected refresh ends the session; retrying would loop forever.
      if (cause instanceof APIError && cause.status === 401) {
        this.callbacks.state("session_expired");
        this.callbacks.sessionExpired?.();
        return;
      }
      setTimeout(() => void this.connect(true), 1000);
    }
  }
  private async reauthenticate(expiredToken: string | null): Promise<void> {
    if (this.stopped) return;
    this.callbacks.state("reconnecting");
    try {
      // Another tab may already have refreshed and broadcast a newer token.
      // Never erase that token in response to an older socket expiring.
      if (this.api.clearToken(expiredToken)) await this.api.refresh();
      if (!this.stopped) void this.connect(true);
    } catch (cause) {
      if (this.stopped) return;
      if (cause instanceof APIError && cause.status === 401) {
        this.callbacks.state("session_expired");
        this.callbacks.sessionExpired?.();
        return;
      }
      setTimeout(() => void this.connect(true), 1000);
    }
  }
  private async receive(raw: string): Promise<void> {
    const frame = JSON.parse(raw) as Record<string, unknown>;
    if (frame.op === "hello") {
      this.reconnectAttempt = 0;
      this.ackInterval = Number(frame.ack_interval_ms) || 1000;
      this.ackBatch = Number(frame.ack_batch_size) || 50;
      this.features = new Set(
        Array.isArray(frame.features) ? frame.features.map(String) : [],
      );
      if (this.presenceState)
        this.send({ op: "presence", state: this.presenceState });
      this.callbacks.state(
        Number(frame.current_seq) > (await this.storage.get())
          ? "backlog"
          : "live",
      );
      this.subscribe(this.active.chatID, this.active.threadRootID);
      return;
    }
    if (frame.op === "event") {
      const event = frame as unknown as DurableEvent;
      if (this.callbacks.event(event)) await this.storage.set(event.seq);
      this.scheduleAck(event.seq);
      this.callbacks.state("live");
      return;
    }
    if (frame.op === "resync_required") {
      this.callbacks.state("resync_required");
      const high = Number(frame.current_seq);
      await this.callbacks.resync(high);
      await this.storage.set(high);
      this.socket?.close();
      return;
    }
    if (frame.op === "error" && frame.code === "password_change_required") {
      this.passwordChangeRequired = true;
      this.callbacks.state("password_change_required");
      this.callbacks.passwordChangeRequired?.();
      return;
    }
    if (frame.op === "typing") this.callbacks.typing?.(frame);
    if (frame.op === "presence") this.callbacks.presence?.(frame);
    if (frame.op === "presence.snapshot")
      this.callbacks.presenceSnapshot?.(frame);
    if (frame.op === "agent.status") this.callbacks.agentStatus?.(frame);
    if (frame.op === "message.streaming")
      this.callbacks.messageStreaming?.(frame);
  }
  private scheduleAck(seq: number): void {
    if (seq - this.lastAck >= this.ackBatch) {
      this.ack(seq);
      return;
    }
    if (!this.ackTimer)
      this.ackTimer = setTimeout(() => this.ack(seq), this.ackInterval);
  }
  private ack(seq: number): void {
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.ackTimer = null;
    this.lastAck = seq;
    this.send({ op: "ack", seq });
  }
  private send(frame: unknown): void {
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(frame));
  }
}
