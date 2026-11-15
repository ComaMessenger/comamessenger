import {
  createMessengerStore,
  restMessageLoader,
  type MessengerAPI,
} from "@comamessenger/core";

/**
 * The domain store of a signed-in session. A realtime frame too large to
 * send whole arrives as a stub (`truncated: true`); the loader reads the
 * whole message by REST and puts it in place. A request whose state an
 * event only hints at is read again the same way. Free of native modules, so the
 * wiring is unit-tested.
 */
export function createAppStore(
  api: Pick<MessengerAPI, "messageContext"> &
    Partial<Pick<MessengerAPI, "messageRequest">>,
) {
  const store = createMessengerStore();
  store.getState().setMessageLoader(restMessageLoader(api));
  // A comment from another device: the event carries no text, the request
  // is read again (phase 6.4).
  if (api.messageRequest) {
    const read = api.messageRequest.bind(api);
    store.getState().setRequestLoader((id) => read(id));
  }
  return store;
}
