import {
  APIError,
  requestSignature,
  type CreateRequestRequest,
} from "@comamessenger/core";

/**
 * Requests on their way to the server («Отправка идёт через outbox с
 * client_msg_id»). Free of native modules so the rules are unit-tested; the
 * storage is passed in (outbox.ts gives it SQLite).
 *
 * - A request is queued before the first call, so it survives the app being
 *   closed with no network.
 * - A retry of the same form reuses its client_msg_id: the server returns
 *   the message it already made instead of a second request.
 * - The server refusing it (4xx) drops it; only the network keeps it.
 */
export type QueuedRequest = {
  clientMsgID: string;
  chatID: string;
  input: CreateRequestRequest;
  signature: string;
  queuedAt: string;
};

export interface RequestQueueStorage {
  load(): Promise<QueuedRequest[]>;
  save(items: QueuedRequest[]): Promise<void>;
}

/** The queued request this form would repeat, if any. */
export function queuedFor(
  items: readonly QueuedRequest[],
  chatID: string,
  signature: string,
): QueuedRequest | null {
  return (
    items.find(
      (item) => item.chatID === chatID && item.signature === signature,
    ) ?? null
  );
}

/** A queue entry for a form: the client_msg_id of a queued twin, or a new one. */
export function enqueue(
  items: readonly QueuedRequest[],
  chatID: string,
  build: (clientMsgID: string) => CreateRequestRequest,
  newID: () => string,
  now: Date,
): { items: QueuedRequest[]; entry: QueuedRequest } {
  // The signature leaves the id out: build once with a placeholder to find
  // a twin, then with the id that will be sent.
  const signature = requestSignature(build(""));
  const twin = queuedFor(items, chatID, signature);
  if (twin) return { items: [...items], entry: twin };
  const clientMsgID = newID();
  const entry: QueuedRequest = {
    clientMsgID,
    chatID,
    input: build(clientMsgID),
    signature,
    queuedAt: now.toISOString(),
  };
  return { items: [...items, entry], entry };
}

export type SendOutcome<T> =
  | { kind: "sent"; message: T }
  /** No network: it stays queued and goes later. */
  | { kind: "queued" }
  /** The server refused it: dropped, the error says why. */
  | { kind: "refused"; error: APIError };

/** Sends one queued request and says what to do with the queue. */
export async function sendQueued<T>(
  entry: QueuedRequest,
  create: (chatID: string, input: CreateRequestRequest) => Promise<T>,
): Promise<SendOutcome<T>> {
  try {
    return { kind: "sent", message: await create(entry.chatID, entry.input) };
  } catch (error) {
    if (error instanceof APIError && error.status < 500 && error.status !== 429)
      return { kind: "refused", error };
    return { kind: "queued" };
  }
}

export function withoutEntry(
  items: readonly QueuedRequest[],
  clientMsgID: string,
): QueuedRequest[] {
  return items.filter((item) => item.clientMsgID !== clientMsgID);
}
