import { APIError, MessengerAPI } from "./api";
import type { ClientMessage, CreateMessageRequest, Message } from "./types";
export type OutboxItem = {
  chatID: string;
  input: CreateMessageRequest;
  createdAt: string;
  attempts: number;
};
export interface OutboxStorage {
  list(): Promise<OutboxItem[]>;
  put(value: OutboxItem): Promise<void>;
  delete(clientMsgID: string): Promise<void>;
}
export class Outbox {
  private running = false;
  constructor(
    private readonly api: MessengerAPI,
    private readonly storage: OutboxStorage,
    private readonly callbacks: {
      optimistic(message: ClientMessage): void;
      delivered(message: Message): void;
      retrying(clientMsgID: string): void;
      failed(clientMsgID: string, code: string): void;
    },
    /**
     * The person whose messages these are. Sending stops as soon as the API
     * holds someone else's token: a queued message is never sent on behalf
     * of the next person signed in on the device.
     */
    private readonly ownerID?: string,
  ) {}
  private ownerSignedIn(): boolean {
    return (
      Boolean(this.api.token()) &&
      (this.ownerID === undefined || this.api.tokenOwnerID() === this.ownerID)
    );
  }
  async enqueue(chatID: string, input: CreateMessageRequest): Promise<void> {
    const item = {
      chatID,
      input,
      createdAt: new Date().toISOString(),
      attempts: 0,
    };
    await this.storage.put(item);
    this.callbacks.optimistic({
      id: input.client_msg_id,
      chat_id: chatID,
      // The sender is known before the server answers: the bubble is drawn
      // on the reader's own side from the first frame, not moved there later.
      actor_id: this.ownerID ?? "",
      client_msg_id: input.client_msg_id,
      type: "text",
      body: input.body,
      body_format: input.body_format ?? "plain",
      reply_to_id: input.reply_to_id ?? null,
      thread_root_id: input.thread_root_id ?? null,
      mentioned_actor_ids: input.mentioned_actor_ids ?? [],
      thread_reply_count: 0,
      version: 1,
      created_seq: Number.MAX_SAFE_INTEGER,
      created_at: item.createdAt,
      edited_at: null,
      deleted_at: null,
      forwarded_from: null,
      files: [],
      delivery: "sending",
    });
    await this.flush();
  }
  async flush(): Promise<void> {
    if (this.running || !this.ownerSignedIn()) return;
    this.running = true;
    try {
      for (const item of await this.storage.list()) {
        if (!this.ownerSignedIn()) return;
        try {
          if (item.attempts > 0)
            this.callbacks.retrying(item.input.client_msg_id);
          const message = await this.api.createMessage(
            item.chatID,
            item.input,
            this.ownerID,
          );
          await this.storage.delete(item.input.client_msg_id);
          this.callbacks.delivered(message);
        } catch (cause) {
          if (
            cause instanceof APIError &&
            cause.code === "idempotency_conflict"
          ) {
            await this.storage.delete(item.input.client_msg_id);
            this.callbacks.failed(item.input.client_msg_id, cause.code);
          } else {
            await this.storage.put({ ...item, attempts: item.attempts + 1 });
            this.callbacks.failed(
              item.input.client_msg_id,
              cause instanceof APIError ? cause.code : "offline",
            );
          }
        }
      }
    } finally {
      this.running = false;
    }
  }
}
