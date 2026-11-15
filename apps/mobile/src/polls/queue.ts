import {
  APIError,
  pollSignature,
  type CreatePollRequest,
} from "@comamessenger/core";

/**
 * Polls on their way to the server (the sheet «Новый опрос»: «отправка —
 * через outbox»). Free of native modules so the rules are unit-tested; the
 * storage is passed in (outbox.ts gives it SQLite). The same rules as the
 * request queue:
 *
 * - a poll is queued before the first call, so it survives the app being
 *   closed with no network;
 * - a retry of the same form reuses its client_msg_id: the server returns
 *   the poll it already made instead of a second one;
 * - the server refusing it (4xx but 429) drops it; only the network keeps it.
 */
export type QueuedPoll = {
  clientMsgID: string;
  chatID: string;
  input: CreatePollRequest;
  signature: string;
  queuedAt: string;
};

/** The queued poll this form would repeat, if any. */
export function queuedPollFor(
  items: readonly QueuedPoll[],
  chatID: string,
  signature: string,
): QueuedPoll | null {
  return (
    items.find(
      (item) => item.chatID === chatID && item.signature === signature,
    ) ?? null
  );
}

/** A queue entry for a form: the client_msg_id of a queued twin, or a new one. */
export function enqueuePoll(
  items: readonly QueuedPoll[],
  chatID: string,
  build: (clientMsgID: string) => CreatePollRequest,
  newID: () => string,
  now: Date,
): { items: QueuedPoll[]; entry: QueuedPoll } {
  const signature = pollSignature(build(""));
  const twin = queuedPollFor(items, chatID, signature);
  if (twin) return { items: [...items], entry: twin };
  const clientMsgID = newID();
  const entry: QueuedPoll = {
    clientMsgID,
    chatID,
    input: build(clientMsgID),
    signature,
    queuedAt: now.toISOString(),
  };
  return { items: [...items, entry], entry };
}

export type PollSendOutcome<T> =
  | { kind: "sent"; message: T }
  /** No network: it stays queued and goes later. */
  | { kind: "queued" }
  /** The server refused it: dropped, the error says why. */
  | { kind: "refused"; error: APIError };

/** Sends one queued poll and says what to do with the queue. */
export async function sendQueuedPoll<T>(
  entry: QueuedPoll,
  create: (chatID: string, input: CreatePollRequest) => Promise<T>,
): Promise<PollSendOutcome<T>> {
  try {
    return { kind: "sent", message: await create(entry.chatID, entry.input) };
  } catch (error) {
    if (error instanceof APIError && error.status < 500 && error.status !== 429)
      return { kind: "refused", error };
    return { kind: "queued" };
  }
}

export function withoutPoll(
  items: readonly QueuedPoll[],
  clientMsgID: string,
): QueuedPoll[] {
  return items.filter((item) => item.clientMsgID !== clientMsgID);
}
