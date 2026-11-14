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
  applySavedChange,
  chatEventEffect,
  savedChange,
  sharedChangedChat,
  sharedKeys,
  pinnedChatLimit,
  type AgentStatusState,
  type ChatFolder,
} from "@comamessenger/core";
import { setLocale } from "@/i18n";
import { createAppStore } from "./appStore";
import { checkpointStorage, outboxStorage } from "@/lib/database";
import { hydrateDrafts } from "@/lib/drafts";
import { reactionsKey } from "@/conversation/reactions";
import { invalidateChatDetails } from "@/chatinfo/queries";
import { usePushNotifications } from "@/push/usePushNotifications";
import { applyScheduledEvent, scheduledKey } from "@/scheduled/scheduledCache";
import { isNetworkError, messageOf } from "@/lib/errors";
import { cacheShell, cachedShell, persistMessages } from "./cache";
import { useSession, useSignedIn } from "@/session/SessionProvider";

export type MessengerStore = ReturnType<typeof createAppStore>;

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
  /** Pins or unpins a chat everywhere; false when the pin limit is reached. */
  togglePinnedChat(chatID: string): Promise<boolean>;
  /** Chat folders shared with the web client, in tab order. */
  folders: ChatFolder[];
  /** Shows the new folders at once and stores them; reverts on failure. */
  saveFolders(next: ChatFolder[]): Promise<void>;
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
  const store = useMemo(() => createAppStore(api), [api]);
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
  const [folders, setFolders] = useState<ChatFolder[]>([]);
  const foldersRef = useRef<ChatFolder[]>([]);
  foldersRef.current = folders;
  const [stale, setStale] = useState(false);
  const hydrated = useRef(false);
  const hydration = useRef<Promise<void>>(Promise.resolve());
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reload = useCallback(async () => {
    await hydration.current;
    try {
      const [chats, unread, pinned, chatFolders] = await Promise.all([
        api.chats(),
        api.unread(),
        api.pinnedChats(),
        // Folders are an extra; the chat list still loads without them.
        api.chatFolders().catch(() => null),
      ]);
      store.getState().replaceChats(chats);
      store.getState().setUnread(unread);
      setPinnedChatIDs(pinned);
      if (chatFolders) setFolders(chatFolders);
      setChatError("");
      setStale(false);
      void cacheShell({
        chats,
        unread,
        pinnedChatIDs: pinned,
        folders: chatFolders ?? foldersRef.current,
      }).catch(() => undefined);
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
            // Scheduled messages reach only the author's devices and carry
            // no text; the cached list fetches what changed.
            if (
              applied &&
              applyScheduledEvent(queryClient, api, user.id, event)
            )
              return true;
            // Saves are private: these events reach only the saver's devices.
            const saved = savedChange(event);
            if (applied && saved) applySavedChange(queryClient, user.id, saved);
            const privateSave =
              event.type === "message.saved" ||
              event.type === "message.unsaved";
            // Members and pins of an open chat info or conversation.
            const chatEffect = applied ? chatEventEffect(event) : null;
            if (chatEffect) invalidateChatDetails(queryClient, chatEffect);
            // Media, files, voice and links of an open chat info.
            const sharedChat = applied ? sharedChangedChat(event) : null;
            if (sharedChat)
              void queryClient.invalidateQueries({
                queryKey: sharedKeys.all(sharedChat),
              });
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
                !privateSave &&
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
            void queryClient.invalidateQueries({
              queryKey: scheduledKey(user.id),
            });
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
      new Outbox(
        api,
        outboxStorage,
        {
          optimistic: store.getState().optimistic,
          delivered: (message) => {
            store.getState().reconcile(message);
            scheduleReload();
          },
          retrying: store.getState().retrying,
          failed: store.getState().failed,
        },
        // Sends only with this person's token (see claimUserData too).
        user.id,
      ),
    [api, scheduleReload, store, user.id],
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
        setFolders(shell.folders ?? []);
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

  const togglePinnedChat = useCallback(
    async (chatID: string) => {
      const pinned = pinnedChatIDs.includes(chatID);
      if (!pinned && pinnedChatIDs.length >= pinnedChatLimit) return false;
      setPinnedChatIDs(
        await api.putPinnedChats(
          pinned
            ? pinnedChatIDs.filter((id) => id !== chatID)
            : [...pinnedChatIDs, chatID],
        ),
      );
      return true;
    },
    [api, pinnedChatIDs],
  );

  const saveFolders = useCallback(
    async (next: ChatFolder[]) => {
      const previous = foldersRef.current;
      setFolders(next);
      try {
        setFolders(await api.putChatFolders(next));
      } catch (cause) {
        setFolders(previous);
        throw cause;
      }
    },
    [api],
  );

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
      togglePinnedChat,
      folders,
      saveFolders,
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
      togglePinnedChat,
      folders,
      saveFolders,
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
