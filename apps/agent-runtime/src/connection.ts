import type { MessengerAPI } from "@comamessenger/core";

export type SocketLike = {
  readyState: number;
  send(value: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
};

export type SocketFactory = (url: string) => SocketLike;
export type AgentStatus =
  | "thinking"
  | "tool"
  | "streaming"
  | "completed"
  | "failed"
  | "canceled";

export class AgentConnectionManager {
  private socket: SocketLike | null = null;
  private stopped = true;
  private reconnectAttempt = 0;
  private lastAck = 0;

  constructor(
    private readonly api: MessengerAPI,
    private readonly consumer: string,
    private readonly sockets: SocketFactory,
    private readonly onEvent: (
      event: Record<string, unknown>,
    ) => Promise<void> = async () => {},
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.socket?.close();
    this.socket = null;
  }

  agentStatus(input: {
    runID: string;
    chatID: string;
    threadRootID: string | null;
    state: AgentStatus;
  }): void {
    this.send({
      op: "agent.status",
      run_id: input.runID,
      chat_id: input.chatID,
      thread_root_id: input.threadRootID,
      state: input.state,
    });
  }

  messageStreaming(input: {
    runID: string;
    chatID: string;
    threadRootID: string | null;
    streamID: string;
    index: number;
    delta: string;
    reset: boolean;
    done: boolean;
  }): void {
    this.send({
      op: "message.streaming",
      run_id: input.runID,
      chat_id: input.chatID,
      thread_root_id: input.threadRootID,
      stream_id: input.streamID,
      index: input.index,
      delta: input.delta,
      reset: input.reset,
      done: input.done,
    });
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    try {
      const checkpoint = await this.api.agentRuntimeCheckpoint(this.consumer);
      const socket = this.sockets(this.api.websocketURL());
      this.socket = socket;
      socket.onopen = () => {
        socket.send(
          JSON.stringify({
            op: "auth",
            request_id: crypto.randomUUID(),
            access_token: this.api.token(),
            last_seq: checkpoint.last_event_seq,
          }),
        );
      };
      socket.onmessage = (event) => void this.receive(event.data);
      socket.onclose = () => this.reconnect();
    } catch {
      this.reconnect();
    }
  }

  private async receive(raw: unknown): Promise<void> {
    const frame = JSON.parse(String(raw)) as Record<string, unknown>;
    if (frame.op === "hello") {
      this.reconnectAttempt = 0;
      return;
    }
    if (frame.op === "event") {
      const seq = Number(frame.seq);
      await this.onEvent(frame);
      await this.api.updateAgentRuntimeCheckpoint(this.consumer, {
        last_event_seq: seq,
      });
      this.lastAck = Math.max(this.lastAck, seq);
      this.socket?.send(JSON.stringify({ op: "ack", seq: this.lastAck }));
      return;
    }
    if (frame.op === "resync_required") {
      const seq = Number(frame.current_seq);
      await this.api.updateAgentRuntimeCheckpoint(this.consumer, {
        last_event_seq: seq,
      });
      this.socket?.close();
    }
  }

  private reconnect(): void {
    if (this.stopped) return;
    this.socket = null;
    const delay =
      Math.min(30_000, 500 * 2 ** this.reconnectAttempt++) +
      Math.random() * 250;
    setTimeout(() => void this.connect(), delay);
  }

  private send(frame: Record<string, unknown>): void {
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(frame));
  }
}
