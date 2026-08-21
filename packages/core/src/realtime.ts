import { APIError, type MessengerAPI } from "./api";
import type { DurableEvent, RealtimeState } from "./types";
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
  ): void {
    this.send({
      op: "typing",
      chat_id: chatID,
      thread_root_id: threadRootID,
      active,
    });
  }
  presence(state: "active" | "away"): void {
    this.send({ op: "presence", state });
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
    } catch {
      if (!this.stopped) setTimeout(() => void this.connect(true), 1000);
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
