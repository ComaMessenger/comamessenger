import type {
  APIError,
  ClientMessage,
  CreateTaskRequest,
  MessengerAPI,
} from "@comamessenger/core";
import { accountValues } from "@/lib/database";
import type { MessengerStore } from "@/messenger/MessengerProvider";
import {
  enqueueTask,
  sendQueuedTask,
  withoutTask,
  type QueuedTask,
} from "./queue";

const key = "task_outbox";

const load = async () => (await accountValues.get<QueuedTask[]>(key)) ?? [];
const save = (items: QueuedTask[]) =>
  accountValues.set(key, items.length ? items : null);

// One queue operation at a time: a flush on reconnect and a fresh send
// must not both send the same entry.
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = chain.then(work, work);
  chain = next.catch(() => undefined);
  return next;
}

type API = Pick<MessengerAPI, "createTask">;

function deliver(store: MessengerStore, message: ClientMessage) {
  // The feed shows it at once; message.created later finds it in place.
  store.getState().reconcile({ ...message, delivery: "sent" });
}

export type TaskSendResult =
  | { kind: "sent"; message: ClientMessage }
  | { kind: "queued" }
  | { kind: "refused"; error: APIError };

/**
 * Sends a task from the «Новая задача» form. It is queued first; a network
 * failure leaves it there for flushTaskOutbox, a refusal removes it.
 */
export function sendTask(
  api: API,
  store: MessengerStore,
  chatID: string,
  build: (clientMsgID: string) => CreateTaskRequest,
): Promise<TaskSendResult> {
  return serial(async () => {
    const queued = enqueueTask(
      await load(),
      chatID,
      build,
      () => crypto.randomUUID(),
      new Date(),
    );
    await save(queued.items);
    const outcome = await sendQueuedTask(queued.entry, (chat, input) =>
      api.createTask(chat, input),
    );
    if (outcome.kind === "queued") return outcome;
    await save(withoutTask(await load(), queued.entry.clientMsgID));
    if (outcome.kind === "sent") deliver(store, outcome.message);
    return outcome;
  });
}

/** Sends what is waiting for the network; stops at the first network failure. */
export function flushTaskOutbox(
  api: API,
  store: MessengerStore,
): Promise<void> {
  return serial(async () => {
    let items = await load();
    for (const entry of [...items]) {
      const outcome = await sendQueuedTask(entry, (chat, input) =>
        api.createTask(chat, input),
      );
      if (outcome.kind === "queued") break;
      items = withoutTask(items, entry.clientMsgID);
      await save(items);
      if (outcome.kind === "sent") deliver(store, outcome.message);
    }
  });
}
