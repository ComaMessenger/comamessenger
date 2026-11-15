import {
  createMessengerStore,
  restMessageLoader,
  type MessengerAPI,
} from "@comamessenger/core";

/**
 * The domain store of a signed-in session. A realtime frame too large to
 * send whole arrives as a stub (`truncated: true`); the loader reads the
 * whole message by REST and puts it in place. A request whose state an
 * event only hints at is read again the same way, and so is a poll card on
 * screen after poll.updated. Free of native modules, so the
 * wiring is unit-tested.
 */
export function createAppStore(
  api: Pick<MessengerAPI, "messageContext"> &
    Partial<Pick<MessengerAPI, "messageRequest" | "messagePoll">>,
  selfID?: string,
) {
  const store = createMessengerStore();
  store.getState().setMessageLoader(restMessageLoader(api));
  // A comment from another device: the event carries no text, the request
  // is read again (phase 6.4).
  if (api.messageRequest) {
    const read = api.messageRequest.bind(api);
    store.getState().setRequestLoader((id) => read(id));
  }
  // Counts of an open poll never come in frames: a card on screen that may
  // see results reads the poll again after poll.updated (phase 6.7).
  if (api.messagePoll) {
    const read = api.messagePoll.bind(api);
    store.getState().setPollLoader((id) => read(id));
  }
  // Whether the reader wrote a poll decides what a retracted vote shows.
  if (selfID) store.getState().setSelfID(selfID);
  return store;
}
