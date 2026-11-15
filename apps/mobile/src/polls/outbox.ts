import type {
  APIError,
  ClientMessage,
  CreatePollRequest,
  MessengerAPI,
} from "@comamessenger/core";
import { accountValues } from "@/lib/database";
import type { MessengerStore } from "@/messenger/MessengerProvider";
import {
  enqueuePoll,
  sendQueuedPoll,
  withoutPoll,
  type QueuedPoll,
} from "./queue";

const key = "poll_outbox";

const load = async () => (await accountValues.get<QueuedPoll[]>(key)) ?? [];
const save = (items: QueuedPoll[]) =>
  accountValues.set(key, items.length ? items : null);

// One queue operation at a time: a flush on reconnect and a fresh send
// must not both send the same entry.
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = chain.then(work, work);
  chain = next.catch(() => undefined);
  return next;
}

type API = Pick<MessengerAPI, "createPoll">;

function deliver(store: MessengerStore, message: ClientMessage) {
  // The feed shows it at once; message.created later finds it in place. The
  // viewer of the reply moves into the store with the message.
  store.getState().reconcile({ ...message, delivery: "sent" });
}

export type PollSendResult =
  | { kind: "sent" }
  | { kind: "queued" }
  | { kind: "refused"; error: APIError };

/**
 * Sends a poll from the sheet «Новый опрос». It is queued first; a network
 * failure leaves it there for flushPollOutbox, a refusal removes it.
 */
export function sendPoll(
  api: API,
  store: MessengerStore,
  chatID: string,
  build: (clientMsgID: string) => CreatePollRequest,
): Promise<PollSendResult> {
  return serial(async () => {
    const queued = enqueuePoll(
      await load(),
      chatID,
      build,
      () => crypto.randomUUID(),
      new Date(),
    );
    await save(queued.items);
    const outcome = await sendQueuedPoll(queued.entry, (chat, input) =>
      api.createPoll(chat, input),
    );
    if (outcome.kind === "queued") return outcome;
    await save(withoutPoll(await load(), queued.entry.clientMsgID));
    if (outcome.kind === "sent") deliver(store, outcome.message);
    return outcome.kind === "sent"
      ? { kind: "sent" }
      : { kind: "refused", error: outcome.error };
  });
}

/** Sends what is waiting for the network; stops at the first network failure. */
export function flushPollOutbox(
  api: API,
  store: MessengerStore,
): Promise<void> {
  return serial(async () => {
    let items = await load();
    for (const entry of [...items]) {
      const outcome = await sendQueuedPoll(entry, (chat, input) =>
        api.createPoll(chat, input),
      );
      if (outcome.kind === "queued") break;
      items = withoutPoll(items, entry.clientMsgID);
      await save(items);
      if (outcome.kind === "sent") deliver(store, outcome.message);
    }
  });
}
