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
  applyReminderEvent,
  applySavedChange,
  chatEventEffect,
  createUnreadRefresher,
  isRequestEvent,
  parseReminderEvent,
  refreshesUnread,
  requestKeys,
  syncDeviceTimezone,
  isTypingAction,
  orgKeys,
  savedChange,
  sharedChangedChat,
  sharedKeys,
  pinnedChatLimit,
  type AgentStatusState,
  type ChatFolder,
  type OrgStructure,
} from "@comamessenger/core";
import { setLocale } from "@/i18n";
import { applyThemePreference } from "@/lib/theme";
import { createAppStore } from "./appStore";
import { cacheStorage, checkpointStorage, outboxStorage } from "@/lib/database";
import { hydrateDrafts } from "@/lib/drafts";
import { reactionsKey } from "@/conversation/reactions";
import { invalidateChatDetails } from "@/chatinfo/queries";
import { usePushNotifications } from "@/push/usePushNotifications";
import { applyScheduledEvent, scheduledKey } from "@/scheduled/scheduledCache";
import { applyOrgEvent } from "@/org/orgEvents";
import { isNetworkError, messageOf } from "@/lib/errors";
import { cacheShell, cachedShell, persistMessages } from "./cache";
import { flushRequestOutbox } from "@/requests/outbox";
import { flushTaskOutbox } from "@/tasks/outbox";
import { applyTaskEvent } from "@/tasks/realtime";
import { flushPollOutbox } from "@/polls/outbox";
import { applyPollEvent } from "@/polls/realtime";
import { applyAwayEvent } from "@/status/realtime";
import { flushReminderActions } from "@/reminders/pushActions";
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
  const store = useMemo(() => createAppStore(api, user.id), [api, user.id]);
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

  // «Ждут вас», the reminder count and the chat marks come from GET /unread;
  // a burst of request and reminder events reads it once (phase 6.4).
  const unreadRefresher = useMemo(
    () =>
      createUnreadRefresher(() =>
        api
          .unread()
          .then((value) => store.getState().setUnread(value))
          .catch(() => undefined),
      ),
    [api, store],
  );
  useEffect(() => () => unreadRefresher.cancel(), [unreadRefresher]);

  const coordinator = useMemo(
    () =>
      new RealtimeCoordinator(
        api,
        checkpointStorage,
        (url) => new WebSocket(url),
        {
          state: store.getState().setRealtime,
          // «Запрос», «Напомнить мне» and the org structure show only when
          // the server has them; kept for an offline start.
          features: (list) => {
            store.getState().setFeatures(list);
            void cacheStorage.set("features", list).catch(() => undefined);
          },
          event: (event) => {
            // A task.updated refreshes the counters only when the reader is
            // on the task before or after it (the store moves it on in apply).
            const previous =
              event.type === "task.updated" &&
              typeof event.data.message_id === "string"
                ? store
                    .getState()
                    .taskOf(
                      event.data.message_id,
                      typeof event.data.chat_id === "string"
                        ? event.data.chat_id
                        : undefined,
                    )
                : undefined;
            const applied = store.getState().apply(event);
            // The org structure changed: read GET /org again (ETag).
            if (applied && applyOrgEvent(queryClient, event)) return true;
            if (
              applied &&
              refreshesUnread(event, {
                me: user.id,
                previous: previous ?? null,
              })
            )
              unreadRefresher.request();
            // The open tasks of the chat (the slot), «Ждут вас» and the task
            // lists follow; the cards in the feed follow the store.
            if (applied) applyTaskEvent(queryClient, user.id, event);
            // Reminders are private: the bells of the chat change at once,
            // the lists in «Важные» on the next look.
            if (applied && event.type.startsWith("reminder.")) {
              const reminder = parseReminderEvent(event);
              if (reminder) applyReminderEvent(queryClient, user.id, reminder);
            }
            // «Ждут вас» and the answers screen read again; the cards in the
            // feed follow the store.
            if (applied && isRequestEvent(event.type)) {
              void queryClient.invalidateQueries({
                queryKey: [...requestKeys.all(user.id), "inbox"],
              });
              if (
                event.type === "request.updated" ||
                event.type === "request.tally.updated"
              )
                void queryClient.invalidateQueries({
                  queryKey: [
                    ...requestKeys.all(user.id),
                    "answers",
                    event.subject_id ||
                      String(
                        (event.data as { message_id?: unknown }).message_id,
                      ),
                  ],
                });
            }
            // Polls (phase 6.7): «Ждут вас» and «Кто голосовал»; the cards
            // follow the store. «Отсутствую»: «Вы замещаете …», «Люди» and
            // the own status when it changed elsewhere or started by itself.
            if (applied) {
              applyPollEvent(queryClient, user.id, event);
              applyAwayEvent(
                queryClient,
                user.id,
                event,
                () =>
                  void api
                    .me()
                    .then(updateUser)
                    .catch(() => undefined),
              );
            }
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
            // Lost org.updated events: the structure is read again.
            void queryClient.invalidateQueries({ queryKey: orgKeys.all });
            void queryClient.invalidateQueries({ queryKey: ["away", user.id] });
            void queryClient.invalidateQueries({
              queryKey: ["polls", user.id],
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
                {
                  action: isTypingAction(frame.action)
                    ? frame.action
                    : "typing",
                  expiresAt: String(frame.expires_at ?? ""),
                  threadRootID: frame.thread_root_id
                    ? String(frame.thread_root_id)
                    : null,
                },
              ),
          presence: (frame) =>
            store
              .getState()
              .setPresence(
                String(frame.actor_id),
                frame.state as "online" | "away" | "offline",
                {
                  expiresAt: String(frame.expires_at ?? ""),
                  ...(frame.last_seen_at
                    ? { lastSeenAt: String(frame.last_seen_at) }
                    : {}),
                },
              ),
          presenceSnapshot: (frame) =>
            store.getState().applyPresenceSnapshot(
              (Array.isArray(frame.actors) ? frame.actors : []).map(
                (item: Record<string, unknown>) => ({
                  actorID: String(item.actor_id),
                  state: item.state === "away" ? "away" : "online",
                  expiresAt: String(item.expires_at),
                }),
              ),
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
          ephemeralReset: () => {
            store.getState().clearAgentEphemeral();
            store.getState().clearTyping();
          },
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
      unreadRefresher,
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
    // Offline start: what the server announced last time and the org
    // structure it gave, until hello and GET /org answer again.
    void Promise.all([
      cacheStorage.get<string[]>("features"),
      cacheStorage.get<OrgStructure>("org"),
    ])
      .then(([features, structure]) => {
        if (features && !store.getState().features.length)
          store.getState().setFeatures(features);
        if (structure && !queryClient.getQueryData(orgKeys.all)) {
          queryClient.setQueryData(orgKeys.all, structure);
          // Stale at once: the first screen reads it again (304 if same).
          void queryClient.invalidateQueries({
            queryKey: orgKeys.all,
            refetchType: "none",
          });
        }
      })
      .catch(() => undefined);
    return persistMessages(store);
  }, [queryClient, store]);

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
      .then((preferences) => {
        setLocale(preferences.locale);
        applyThemePreference(preferences.theme);
      })
      .catch(() => undefined);
    // The app is in the foreground while it runs; going to the background
    // closes the socket, which the server reports as offline.
    coordinator.presence("active");
    coordinator.start();
    void outbox.flush();
    // Requests and polls sent offline and reminder buttons pressed in a push while the
    // app could not reach the server go now.
    void flushRequestOutbox(api, store).catch(() => undefined);
    void flushTaskOutbox(api, store).catch(() => undefined);
    void flushPollOutbox(api, store).catch(() => undefined);
    void flushReminderActions(api, queryClient, user.id).catch(() => undefined);
    return () => {
      // Signed out: the next account brings its own theme.
      applyThemePreference(null);
      coordinator.stop();
      if (reloadTimer.current !== null) clearTimeout(reloadTimer.current);
    };
  }, [api, coordinator, outbox, queryClient, reload, store, user.id]);

  // The profile time zone stays «UTC» until someone picks one; the server
  // writes push times in it, so the device's zone goes there quietly.
  const timezoneSynced = useRef(false);
  useEffect(() => {
    if (timezoneSynced.current) return;
    timezoneSynced.current = true;
    void syncDeviceTimezone(api, user).then((updated) => {
      if (updated) updateUser(updated);
    });
  }, [api, updateUser, user]);

  usePushNotifications(api, store, queryClient, user.id);

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
        void flushRequestOutbox(api, store).catch(() => undefined);
        void flushTaskOutbox(api, store).catch(() => undefined);
        void flushPollOutbox(api, store).catch(() => undefined);
        void flushReminderActions(api, queryClient, user.id).catch(
          () => undefined,
        );
      }
    });
    return () => subscription.remove();
  }, [api, coordinator, outbox, queryClient, reload, store, user.id]);

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
