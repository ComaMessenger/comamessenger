import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AppState } from "react-native";
import {
  Outbox,
  RealtimeCoordinator,
  createMessengerStore,
} from "@comamessenger/core";
import { setLocale } from "@/i18n";
import { checkpointStorage, outboxStorage } from "@/lib/database";
import { messageOf } from "@/lib/errors";
import { useSession, useSignedIn } from "@/session/SessionProvider";

export type MessengerStore = ReturnType<typeof createMessengerStore>;

type MessengerValue = {
  store: MessengerStore;
  coordinator: RealtimeCoordinator;
  outbox: Outbox;
  reload(): Promise<void>;
  chatLoading: boolean;
  chatError: string;
  /** Chats the user pinned on any device, in their order. */
  pinnedChatIDs: string[];
};

const MessengerContext = createContext<MessengerValue | null>(null);

export function useMessenger(): MessengerValue {
  const value = useContext(MessengerContext);
  if (!value)
    throw new Error("useMessenger must be used inside <MessengerProvider>");
  return value;
}

/**
 * Realtime session of the signed-in user: the shared domain store, websocket
 * coordinator and outbox from packages/core, wired to the app lifecycle.
 */
export function MessengerProvider({ children }: { children: ReactNode }) {
  const { api, user } = useSignedIn();
  const { sessionExpired, updateUser } = useSession();
  const store = useMemo(() => createMessengerStore(), []);
  const [chatLoading, setChatLoading] = useState(true);
  const [chatError, setChatError] = useState("");
  const [pinnedChatIDs, setPinnedChatIDs] = useState<string[]>([]);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reload = useCallback(async () => {
    try {
      const [chats, unread, pinned] = await Promise.all([
        api.chats(),
        api.unread(),
        api.pinnedChats(),
      ]);
      store.getState().replaceChats(chats);
      store.getState().setUnread(unread);
      setPinnedChatIDs(pinned);
      setChatError("");
    } catch (cause) {
      setChatError(messageOf(cause));
    } finally {
      setChatLoading(false);
    }
  }, [api, store]);

  const scheduleReload = useCallback(() => {
    if (reloadTimer.current !== null) clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(() => {
      reloadTimer.current = null;
      void reload();
    }, 120);
  }, [reload]);

  const coordinator = useMemo(
    () =>
      new RealtimeCoordinator(
        api,
        checkpointStorage,
        (url) => new WebSocket(url),
        {
          state: store.getState().setRealtime,
          event: (event) => {
            const applied = store.getState().apply(event);
            const profileEvent =
              event.type === "actor.status.updated" ||
              event.type === "actor.avatar.updated";
            if (profileEvent && event.actor_id === user.id)
              void api.me().then(updateUser);
            if (
              (applied &&
                (event.type.startsWith("chat.") ||
                  event.type.startsWith("member.") ||
                  event.type.startsWith("message."))) ||
              profileEvent
            )
              scheduleReload();
            return applied || profileEvent;
          },
          resync: async (watermark) => {
            const active = store.getState().activeChatID;
            store.getState().resetDurable(watermark);
            await reload();
            if (active) {
              const page = await api.messages(active, { limit: 50 });
              store.getState().replaceMessages(active, page.messages);
            }
          },
          typing: (frame) =>
            store
              .getState()
              .setTyping(
                String(frame.chat_id),
                String(frame.actor_id),
                Boolean(frame.active),
              ),
          presence: (frame) =>
            store
              .getState()
              .setPresence(
                String(frame.actor_id),
                frame.state as "online" | "away" | "offline",
              ),
          ephemeralReset: () => store.getState().clearAgentEphemeral(),
          passwordChangeRequired: () => void api.me().then(updateUser),
          sessionExpired,
        },
      ),
    [api, reload, scheduleReload, sessionExpired, store, updateUser, user.id],
  );

  const outbox = useMemo(
    () =>
      new Outbox(api, outboxStorage, {
        optimistic: store.getState().optimistic,
        delivered: (message) => {
          store.getState().reconcile(message);
          scheduleReload();
        },
        retrying: store.getState().retrying,
        failed: store.getState().failed,
      }),
    [api, scheduleReload, store],
  );

  useEffect(() => {
    void reload();
    void api
      .preferences()
      .then((preferences) => setLocale(preferences.locale))
      .catch(() => undefined);
    coordinator.start();
    void outbox.flush();
    return () => {
      coordinator.stop();
      if (reloadTimer.current !== null) clearTimeout(reloadTimer.current);
    };
  }, [api, coordinator, outbox, reload]);

  // iOS suspends a backgrounded app, leaving a socket that looks open but is
  // dead. Close it explicitly and resume from the checkpoint on return.
  useEffect(() => {
    let backgrounded = false;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "background" && !backgrounded) {
        backgrounded = true;
        coordinator.stop();
      } else if (state === "active" && backgrounded) {
        backgrounded = false;
        coordinator.start();
        void reload();
        void outbox.flush();
      }
    });
    return () => subscription.remove();
  }, [coordinator, outbox, reload]);

  const value = useMemo<MessengerValue>(
    () => ({
      store,
      coordinator,
      outbox,
      reload,
      chatLoading,
      chatError,
      pinnedChatIDs,
    }),
    [store, coordinator, outbox, reload, chatLoading, chatError, pinnedChatIDs],
  );
  return (
    <MessengerContext.Provider value={value}>
      {children}
    </MessengerContext.Provider>
  );
}
