import type {
  APIError,
  ClientMessage,
  CreateRequestRequest,
  MessengerAPI,
} from "@comamessenger/core";
import { accountValues } from "@/lib/database";
import type { MessengerStore } from "@/messenger/MessengerProvider";
import { enqueue, sendQueued, withoutEntry, type QueuedRequest } from "./queue";

const key = "request_outbox";

const load = async () => (await accountValues.get<QueuedRequest[]>(key)) ?? [];
const save = (items: QueuedRequest[]) =>
  accountValues.set(key, items.length ? items : null);

// One queue operation at a time: a flush on reconnect and a fresh send
// must not both send the same entry.
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = chain.then(work, work);
  chain = next.catch(() => undefined);
  return next;
}

type API = Pick<MessengerAPI, "createRequest">;

function deliver(store: MessengerStore, message: ClientMessage) {
  // The feed shows it at once; message.created later finds it in place.
  store.getState().reconcile({ ...message, delivery: "sent" });
}

export type RequestSendResult =
  | { kind: "sent" }
  | { kind: "queued" }
  | { kind: "refused"; error: APIError };

/**
 * Sends a request from the «Запрос» form. It is queued first; a network
 * failure leaves it there for flushRequestOutbox, a refusal removes it.
 */
export function sendRequest(
  api: API,
  store: MessengerStore,
  chatID: string,
  build: (clientMsgID: string) => CreateRequestRequest,
): Promise<RequestSendResult> {
  return serial(async () => {
    const queued = enqueue(
      await load(),
      chatID,
      build,
      () => crypto.randomUUID(),
      new Date(),
    );
    await save(queued.items);
    const outcome = await sendQueued(queued.entry, (chat, input) =>
      api.createRequest(chat, input),
    );
    if (outcome.kind === "queued") return outcome;
    await save(withoutEntry(await load(), queued.entry.clientMsgID));
    if (outcome.kind === "sent") deliver(store, outcome.message);
    return outcome.kind === "sent"
      ? { kind: "sent" }
      : { kind: "refused", error: outcome.error };
  });
}

/** Sends what is waiting for the network; stops at the first network failure. */
export function flushRequestOutbox(
  api: API,
  store: MessengerStore,
): Promise<void> {
  return serial(async () => {
    let items = await load();
    for (const entry of [...items]) {
      const outcome = await sendQueued(entry, (chat, input) =>
        api.createRequest(chat, input),
      );
      if (outcome.kind === "queued") break;
      items = withoutEntry(items, entry.clientMsgID);
      await save(items);
      if (outcome.kind === "sent") deliver(store, outcome.message);
    }
  });
}
