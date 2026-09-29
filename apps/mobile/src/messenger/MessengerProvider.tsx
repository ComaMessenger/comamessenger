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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outbox,
  RealtimeCoordinator,
  createMessengerStore,
  type AgentStatusState,
} from "@comamessenger/core";
import { setLocale } from "@/i18n";
import { checkpointStorage, outboxStorage } from "@/lib/database";
import { hydrateDrafts } from "@/lib/drafts";
import { reactionsKey } from "@/conversation/reactions";
import { usePushNotifications } from "@/push/usePushNotifications";
import { isNetworkError, messageOf } from "@/lib/errors";
import { cacheShell, cachedShell, persistMessages } from "./cache";
import { useSession, useSignedIn } from "@/session/SessionProvider";

export type MessengerStore = ReturnType<typeof createMessengerStore>;

type MessengerValue = {
  store: MessengerStore;
  coordinator: RealtimeCoordinator;
  outbox: Outbox;
  reload(): Promise<void>;
  /** Coalesces chat list refreshes after local changes. */
  scheduleReload(): void;
  chatLoading: boolean;
  chatError: string;
  /** The chat list comes from the offline cache and the server is unreachable. */
  stale: boolean;
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
  // Request-lived data (members, reactions, thread pages); event-lived state
  // stays in the domain store, as on the web (ADR-0009).
  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: 1, staleTime: 15_000 } },
      }),
    [],
  );
  const [chatLoading, setChatLoading] = useState(true);
  const [chatError, setChatError] = useState("");
  const [pinnedChatIDs, setPinnedChatIDs] = useState<string[]>([]);
  const [stale, setStale] = useState(false);
  const hydrated = useRef(false);
  const hydration = useRef<Promise<void>>(Promise.resolve());
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reload = useCallback(async () => {
    await hydration.current;
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
      setStale(false);
      void cacheShell({ chats, unread, pinnedChatIDs: pinned }).catch(
        () => undefined,
      );
    } catch (cause) {
      // Saved data stays on screen when the network is the only problem.
      if (hydrated.current && isNetworkError(cause)) setStale(true);
      else setChatError(messageOf(cause));
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
            if (event.type.startsWith("reaction."))
              void queryClient.invalidateQueries({
                queryKey: reactionsKey(event.subject_id),
              });
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
          agentStatus: (frame) =>
            store.getState().setAgentStatus({
              runID: String(frame.run_id),
              actorID: String(frame.actor_id),
              chatID: String(frame.chat_id),
              threadRootID: frame.thread_root_id
                ? String(frame.thread_root_id)
                : null,
              state: frame.state as AgentStatusState["state"],
              expiresAt: String(frame.expires_at),
            }),
          messageStreaming: (frame) =>
            store.getState().applyMessageStream({
              streamID: String(frame.stream_id),
              runID: String(frame.run_id),
              actorID: String(frame.actor_id),
              chatID: String(frame.chat_id),
              threadRootID: frame.thread_root_id
                ? String(frame.thread_root_id)
                : null,
              delta: String(frame.delta ?? ""),
              index: Number(frame.index),
              reset: Boolean(frame.reset),
              done: Boolean(frame.done),
              expiresAt: String(frame.expires_at),
            }),
          ephemeralReset: () => store.getState().clearAgentEphemeral(),
          passwordChangeRequired: () => void api.me().then(updateUser),
          sessionExpired,
        },
      ),
    [
      api,
      queryClient,
      reload,
      scheduleReload,
      sessionExpired,
      store,
      updateUser,
      user.id,
    ],
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

  // Saved chats appear before the network answers; unsubscribed on sign-out.
  useEffect(() => {
    hydration.current = cachedShell()
      .then((shell) => {
        if (!shell || Object.keys(store.getState().chats).length) return;
        hydrated.current = true;
        store.getState().replaceChats(shell.chats);
        store.getState().setUnread(shell.unread);
        setPinnedChatIDs(shell.pinnedChatIDs);
        setChatLoading(false);
      })
      .catch(() => undefined);
    return persistMessages(store);
  }, [store]);

  // After an offline start the account is refreshed once the server answers.
  const liveOnce = useRef(false);
  useEffect(
    () =>
      store.subscribe((state) => {
        if (state.realtime !== "live" || liveOnce.current) return;
        liveOnce.current = true;
        setStale(false);
        void api
          .me()
          .then(updateUser)
          .catch(() => undefined);
      }),
    [api, store, updateUser],
  );

  useEffect(() => {
    void reload();
    void api
      .drafts()
      .then(hydrateDrafts)
      .catch(() => undefined);
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

  usePushNotifications(api, store);

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
      scheduleReload,
      chatLoading,
      chatError,
      stale,
      pinnedChatIDs,
    }),
    [
      store,
      coordinator,
      outbox,
      reload,
      scheduleReload,
      chatLoading,
      chatError,
      stale,
      pinnedChatIDs,
    ],
  );
  return (
    <QueryClientProvider client={queryClient}>
      <MessengerContext.Provider value={value}>
        {children}
      </MessengerContext.Provider>
    </QueryClientProvider>
  );
}
