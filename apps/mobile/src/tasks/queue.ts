import {
  APIError,
  taskSignature,
  type CreateTaskRequest,
} from "@comamessenger/core";

/**
 * Tasks on their way to the server («Отправка — через outbox с
 * client_msg_id»), the same rules as the request queue of wave 1. Free of
 * native modules so the rules are unit-tested; outbox.ts gives it SQLite.
 *
 * - A task is queued before the first call, so it survives the app being
 *   closed with no network.
 * - A retry of the same form reuses its client_msg_id: the server returns
 *   the task it already made instead of a second one.
 * - The server refusing it (4xx) drops it; only the network keeps it.
 */
export type QueuedTask = {
  clientMsgID: string;
  chatID: string;
  input: CreateTaskRequest;
  signature: string;
  queuedAt: string;
};

/** The queued task this form would repeat, if any. */
export function queuedTaskFor(
  items: readonly QueuedTask[],
  chatID: string,
  signature: string,
): QueuedTask | null {
  return (
    items.find(
      (item) => item.chatID === chatID && item.signature === signature,
    ) ?? null
  );
}

/** A queue entry for a form: the client_msg_id of a queued twin, or a new one. */
export function enqueueTask(
  items: readonly QueuedTask[],
  chatID: string,
  build: (clientMsgID: string) => CreateTaskRequest,
  newID: () => string,
  now: Date,
): { items: QueuedTask[]; entry: QueuedTask } {
  // The signature leaves the id out: build once with a placeholder to find
  // a twin, then with the id that will be sent.
  const signature = taskSignature(build(""));
  const twin = queuedTaskFor(items, chatID, signature);
  if (twin) return { items: [...items], entry: twin };
  const clientMsgID = newID();
  const entry: QueuedTask = {
    clientMsgID,
    chatID,
    input: build(clientMsgID),
    signature,
    queuedAt: now.toISOString(),
  };
  return { items: [...items, entry], entry };
}

export type TaskSendOutcome<T> =
  | { kind: "sent"; message: T }
  /** No network: it stays queued and goes later. */
  | { kind: "queued" }
  /** The server refused it: dropped, the error says why. */
  | { kind: "refused"; error: APIError };

/** Sends one queued task and says what to do with the queue. */
export async function sendQueuedTask<T>(
  entry: QueuedTask,
  create: (chatID: string, input: CreateTaskRequest) => Promise<T>,
): Promise<TaskSendOutcome<T>> {
  try {
    return { kind: "sent", message: await create(entry.chatID, entry.input) };
  } catch (error) {
    if (error instanceof APIError && error.status < 500 && error.status !== 429)
      return { kind: "refused", error };
    return { kind: "queued" };
  }
}

export function withoutTask(
  items: readonly QueuedTask[],
  clientMsgID: string,
): QueuedTask[] {
  return items.filter((item) => item.clientMsgID !== clientMsgID);
}
