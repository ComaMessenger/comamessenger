import {
  createMessengerStore,
  restMessageLoader,
  type MessengerAPI,
} from "@comamessenger/core";

/**
 * The domain store of a signed-in session. A realtime frame too large to
 * send whole arrives as a stub (`truncated: true`); the loader reads the
 * whole message by REST and puts it in place. Free of native modules, so the
 * wiring is unit-tested.
 */
export function createAppStore(api: Pick<MessengerAPI, "messageContext">) {
  const store = createMessengerStore();
  store.getState().setMessageLoader(restMessageLoader(api));
  return store;
}
