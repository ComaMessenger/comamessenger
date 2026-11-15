import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  MessengerAPI,
  applySavedChange,
  savedChange,
  Outbox,
  RealtimeCoordinator,
  createMessengerStore,
  restMessageLoader,
  expandUUID,
  isScheduledEvent,
  isTypingAction,
  messagePlainText,
  sharedChangedChat,
  sharedKeys,
  orgEventEffect,
  orgKeys,
  pinnedChatLimit,
  createUnreadRefresher,
  parseTaskEvent,
  refreshesUnread,
  syncDeviceTimezone,
  type Chat,
  type ChatFolder,
  type DurableEvent,
  type OrgStructure,
  type ScheduledMessageEvent,
  type User,
  type UserPreferences,
} from "@comamessenger/core";
import i18n, { setLocale } from "../i18n";
import { checkpointStorageFor, outboxStorageFor } from "../persistence";
import { setTheme } from "../theme";
import { messageOf } from "../errors";
import { hydrateDrafts } from "../lib/drafts";
import {
  playNotificationSound,
  shouldPlayNotificationSound,
  shouldShowInAppNotification,
  unlockNotificationSound,
} from "../notificationSound";
import {
  applyScheduledEvent,
  releaseScheduledCache,
  scheduledQueryKey,
} from "../scheduled/useScheduled";
import { applyWorkplaceEvent, invalidateWorkplace } from "../requests/realtime";
import { applyTaskEvent } from "../tasks/realtime";
import { applyAwayEvent } from "../status/realtime";
import { taskNotice, taskNoticeAllowed } from "../tasks/notice";
import { applyPollEvent } from "../polls/realtime";
import { pollNotice, pollNoticeAllowed } from "../polls/notice";

export type InAppNotification = {
  id: string;
  title: string;
  body: string;
  url: string;
  avatarName: string;
  avatarSeed: string;
  mention: boolean;
};

export { pinnedChatLimit };

async function loadMessages(
  api: MessengerAPI,
  store: ReturnType<typeof createMessengerStore>,
  chatID: string,
) {
  const page = await api.messages(chatID, { limit: 50 });
  store.getState().replaceMessages(chatID, page.messages);
}

/**
 * Owns the realtime session of the signed-in user: store, websocket
 * coordinator, outbox, chat list reloads, in-app notifications and the
 * account-level preferences (folders, pinned chats, snooze).
 */
export function useMessengerSession({
  api,
  user,
  path,
  navigate,
  onLogout,
  onUserUpdated,
}: {
  api: MessengerAPI;
  user: User;
  path: string;
  navigate(to: string): void;
  onLogout(): void;
  onUserUpdated(user: User): void;
}) {
  const store = useMemo(() => {
    const created = createMessengerStore();
    // A realtime frame too large to send whole arrives as a stub.
    created.getState().setMessageLoader(restMessageLoader(api));
    // A comment or answer from another device: the event does not carry it.
    created.getState().setRequestLoader((id) => api.messageRequest(id));
    // Counts of open polls never come in frames: cards on screen read them.
    created.getState().setPollLoader((id) => api.messagePoll(id));
    return created;
  }, [api]);
  useEffect(() => {
    store.getState().setSelfID(user.id);
  }, [store, user.id]);
  const queryClient = useQueryClient();
  // The list of scheduled messages belongs to this person only: lists left
  // by someone who used this tab before are dropped on sign-in, this
  // person's on sign-out (the messenger unmounts).
  useEffect(() => {
    releaseScheduledCache(queryClient, user.id);
    return () => releaseScheduledCache(queryClient, null);
  }, [queryClient, user.id]);
  const [folders, setFolders] = useState<ChatFolder[]>([]);
  const [pinnedChatIDs, setPinnedChatIDs] = useState<string[]>([]);
  const [snoozedUntil, setSnoozedUntil] = useState<string | null>(null);
  const [chatLoading, setChatLoading] = useState(true);
  const [chatError, setChatError] = useState("");
  const [inAppNotifications, setInAppNotifications] = useState<
    InAppNotification[]
  >([]);
  const notificationPreferences = useRef<UserPreferences | null>(null);
  const inAppNotificationTimers = useRef(new Map<string, number>());
  const reloadTimer = useRef<number | null>(null);
  const [ready] = useState(() => {
    let resolve: () => void = () => undefined;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  });

  const selectedID = /^\/chat\/([^/]+)/.exec(path)?.[1] ?? null;
  const threadID = /\/thread\/([^/]+)/.exec(path)?.[1] ?? null;

  const reload = useCallback(async () => {
    try {
      const [chatList, counts] = await Promise.all([api.chats(), api.unread()]);
      store.getState().replaceChats(chatList);
      store.getState().setUnread(counts);
      setChatError("");
    } catch (cause) {
      setChatError(messageOf(cause));
    } finally {
      setChatLoading(false);
      ready.resolve();
    }
  }, [api, ready, store]);

  // Waiting for you, fired reminders and the chat marks come from GET /unread:
  // a burst of request and reminder events reads it once.
  const unreadRefresher = useMemo(
    () =>
      createUnreadRefresher(() =>
        api
          .unread()
          .then((counts) => store.getState().setUnread(counts))
          .catch(() => undefined),
      ),
    [api, store],
  );
  useEffect(() => () => unreadRefresher.cancel(), [unreadRefresher]);

  const scheduleReload = useCallback(() => {
    if (reloadTimer.current !== null) window.clearTimeout(reloadTimer.current);
    reloadTimer.current = window.setTimeout(() => {
      reloadTimer.current = null;
      void reload();
    }, 120);
  }, [reload]);

  const dismissInAppNotification = useCallback((id: string) => {
    const timer = inAppNotificationTimers.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    inAppNotificationTimers.current.delete(id);
    setInAppNotifications((current) =>
      current.filter((notification) => notification.id !== id),
    );
  }, []);

  const showInAppNotification = useCallback(
    (
      event: DurableEvent,
      chat: Chat | undefined,
      content?: { title: string; body: string; url: string },
    ) => {
      const id = `${event.seq}:${event.type}`;
      const messageBody =
        typeof event.data.body === "string"
          ? messagePlainText(event.data.body).trim()
          : "";
      const contextName = chat?.display_name || user.organization_name;
      const title =
        event.type === "message.created"
          ? i18n.t("inAppNewMessage", { chat: contextName })
          : event.type === "reaction.added"
            ? i18n.t("inAppNewReaction", { chat: contextName })
            : i18n.t("inAppChatEvent", { chat: contextName });
      const body = messageBody || i18n.t("inAppOpenChat");
      const threadRoot =
        typeof event.data.thread_root_id === "string"
          ? event.data.thread_root_id
          : null;
      const mentioned = Array.isArray(event.data.mentioned_actor_ids)
        ? (event.data.mentioned_actor_ids as string[]).includes(user.id)
        : false;
      const notification: InAppNotification = content
        ? {
            id,
            ...content,
            avatarName: contextName,
            avatarSeed: chat?.avatar_seed || chat?.id || user.org_id,
            mention: true,
          }
        : {
        id,
        title,
        body,
        url:
          event.chat_id && threadRoot
            ? `/chat/${event.chat_id}/thread/${threadRoot}`
            : event.chat_id
              ? `/chat/${event.chat_id}`
              : "/members",
        avatarName: contextName,
        avatarSeed: chat?.avatar_seed || chat?.id || user.org_id,
        mention: mentioned,
          };
      setInAppNotifications((current) => [
        ...current.filter((item) => item.id !== id).slice(-2),
        notification,
      ]);
      const previousTimer = inAppNotificationTimers.current.get(id);
      if (previousTimer !== undefined) window.clearTimeout(previousTimer);
      inAppNotificationTimers.current.set(
        id,
        window.setTimeout(() => dismissInAppNotification(id), 7000),
      );
    },
    [dismissInAppNotification, user.id, user.org_id, user.organization_name],
  );

  const orgRefetchTimer = useRef<number | null>(null);
  const scheduleOrgRefetch = useCallback(
    (delayMs: number) => {
      if (orgRefetchTimer.current !== null) return;
      orgRefetchTimer.current = window.setTimeout(() => {
        orgRefetchTimer.current = null;
        void queryClient.invalidateQueries({ queryKey: orgKeys.all });
      }, delayMs);
    },
    [queryClient],
  );
  useEffect(
    () => () => {
      if (orgRefetchTimer.current !== null)
        window.clearTimeout(orgRefetchTimer.current);
    },
    [],
  );

  const coordinator = useMemo(
    () =>
      new RealtimeCoordinator(
        api,
        checkpointStorageFor(user.id),
        (url) => new WebSocket(url),
        {
          state: store.getState().setRealtime,
          features: (list) => store.getState().setFeatures(list),
          event: (event) => {
            // org.updated carries no content: read GET /org again after a
            // short pause that gathers a burst of writes.
            const org = orgEventEffect(
              event,
              queryClient.getQueryData<OrgStructure>(orgKeys.all)?.version,
            );
            if (org) {
              if (org.kind === "refetch") scheduleOrgRefetch(org.delayMs);
              return true;
            }
            // The reader's part in a task before the update: losing it
            // changes Waiting for you and the counters as much as gaining it.
            const previousTask =
              event.type === "task.updated" &&
              typeof event.data.message_id === "string"
                ? (store.getState().taskOf(event.data.message_id) ??
                  undefined)
                : undefined;
            const applied = store.getState().apply(event);
            if (
              refreshesUnread(
                event,
                previousTask !== undefined
                  ? { me: user.id, previous: previousTask }
                  : undefined,
              )
            )
              unreadRefresher.request();
            applyTaskEvent(queryClient, user.id, event);
            const taskNotified =
              event.type === "task.notified" ? parseTaskEvent(event) : null;
            if (
              taskNotified?.type === "task.notified" &&
              document.visibilityState === "visible" &&
              taskNotified.data.chat_id !== store.getState().activeChatID
            ) {
              const taskChat = store.getState().chats[taskNotified.data.chat_id];
              if (
                taskNoticeAllowed(
                  taskNotified.data.kind,
                  notificationPreferences.current,
                  taskChat,
                  new Date(event.occurred_at),
                )
              )
                showInAppNotification(event, taskChat, {
                  ...taskNotice(
                    taskNotified.data.kind,
                    store
                      .getState()
                      .taskOf(
                        taskNotified.data.message_id,
                        taskNotified.data.chat_id,
                      )?.title ?? null,
                    taskChat?.display_name || user.organization_name,
                  ),
                  url: `/chat/${taskNotified.data.chat_id}?message=${taskNotified.data.message_id}`,
                });
            }
            const pollNotified = applyPollEvent(queryClient, user.id, event);
            if (
              pollNotified &&
              document.visibilityState === "visible" &&
              pollNotified.chat_id !== store.getState().activeChatID
            ) {
              const pollChat = store.getState().chats[pollNotified.chat_id];
              if (
                pollNoticeAllowed(
                  pollNotified.kind,
                  notificationPreferences.current,
                  pollChat,
                  new Date(event.occurred_at),
                )
              )
                showInAppNotification(event, pollChat, {
                  ...pollNotice(
                    pollNotified.kind,
                    store
                      .getState()
                      .messages[pollNotified.chat_id]?.find(
                        (item) => item.id === pollNotified.message_id,
                      )?.poll?.question ?? null,
                    pollChat?.display_name || user.organization_name,
                  ),
                  url: `/chat/${pollNotified.chat_id}?message=${pollNotified.message_id}`,
                });
            }
            // Requests and reminders: private lists and the reader's own
            // reminders, which only reach the owner's devices.
            applyAwayEvent(queryClient, user.id, event, () =>
              void api.me().then(onUserUpdated),
            );
            if (applyWorkplaceEvent(queryClient, user.id, event))
              return applied || event.type.startsWith("reminder.");
            // Saves are private: these events reach only the saver's devices.
            const saved = savedChange(event);
            if (applied && saved) applySavedChange(queryClient, user.id, saved);
            const privateSave =
              event.type === "message.saved" ||
              event.type === "message.unsaved";
            if (isScheduledEvent(event.type)) {
              // Only the author's devices receive these; they carry no
              // text, so the record is read again when it changed.
              applyScheduledEvent(
                queryClient,
                api,
                user.id,
                event.type,
                event.data as unknown as ScheduledMessageEvent,
              );
              return applied;
            }
            const chat = event.chat_id
              ? store.getState().chats[String(event.chat_id)]
              : undefined;
            if (
              document.visibilityState === "visible" &&
              event.chat_id !== store.getState().activeChatID &&
              shouldShowInAppNotification(
                event,
                user,
                notificationPreferences.current,
                chat,
              )
            ) {
              showInAppNotification(event, chat);
              if (
                shouldPlayNotificationSound(
                  event,
                  user,
                  notificationPreferences.current,
                  chat,
                )
              )
                playNotificationSound();
            }
            const profileEvent =
              event.type === "actor.status.updated" ||
              event.type === "actor.avatar.updated";
            if (profileEvent && event.actor_id === user.id)
              void api.me().then(onUserUpdated);
            if (
              applied &&
              !privateSave &&
              (event.type.startsWith("chat.") ||
                event.type.startsWith("member.") ||
                event.type.startsWith("message."))
            )
              scheduleReload();
            if (profileEvent) scheduleReload();
            // Chat info tabs (media, files, voice, links) follow new, edited
            // and deleted messages; closed tabs just turn stale.
            const sharedChat = sharedChangedChat(event);
            if (applied && sharedChat)
              void queryClient.invalidateQueries({
                queryKey: sharedKeys.all(sharedChat),
              });
            return applied || profileEvent;
          },
          resync: async (watermark) => {
            const active = store.getState().activeChatID;
            store.getState().resetDurable(watermark);
            // Events missed while away are not replayed: read the list anew.
            void queryClient.invalidateQueries({
              queryKey: scheduledQueryKey(user.id),
            });
            invalidateWorkplace(queryClient, user.id);
            void queryClient.invalidateQueries({ queryKey: ["away", user.id] });
            void queryClient.invalidateQueries({ queryKey: orgKeys.all });
            await reload();
            if (active) await loadMessages(api, store, active);
          },
          typing: (frame) =>
            store
              .getState()
              .setTyping(
                String(frame.chat_id),
                String(frame.actor_id),
                Boolean(frame.active),
                {
                  action: isTypingAction(frame.action) ? frame.action : "typing",
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
              state: frame.state as
                | "thinking"
                | "tool"
                | "streaming"
                | "completed"
                | "failed"
                | "canceled",
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
          passwordChangeRequired: () => {
            void api.me().then(onUserUpdated);
          },
          sessionExpired: onLogout,
        },
      ),
    [
      api,
      onLogout,
      onUserUpdated,
      queryClient,
      reload,
      scheduleReload,
      scheduleOrgRefetch,
      showInAppNotification,
      store,
      unreadRefresher,
      user,
    ],
  );

  const outbox = useMemo(
    () =>
      new Outbox(
        api,
        outboxStorageFor(user.id),
        {
          optimistic: store.getState().optimistic,
          delivered: (message) => {
            store.getState().reconcile(message);
            scheduleReload();
          },
          retrying: store.getState().retrying,
          failed: store.getState().failed,
        },
        user.id,
      ),
    [api, scheduleReload, store, user.id],
  );

  useEffect(() => {
    const unlock = () => unlockNotificationSound();
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    const updatePreferences = (event: Event) => {
      const preferences = (event as CustomEvent<UserPreferences>).detail;
      notificationPreferences.current = preferences;
      setSnoozedUntil(preferences.snoozed_until);
    };
    const refreshPreferences = () =>
      void api.preferences().then((preferences) => {
        notificationPreferences.current = preferences;
        setSnoozedUntil(preferences.snoozed_until);
      });
    window.addEventListener("coma-preferences-updated", updatePreferences);
    window.addEventListener("coma-notifications-changed", refreshPreferences);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      window.removeEventListener("coma-preferences-updated", updatePreferences);
      window.removeEventListener(
        "coma-notifications-changed",
        refreshPreferences,
      );
    };
  }, [api]);

  // A profile still on the default zone takes the device's zone, so the
  // server words reminder and request pushes in local time.
  useEffect(() => {
    void syncDeviceTimezone(api, user).then((updated) => {
      if (updated?.id === user.id) onUserUpdated(updated);
    });
    // Once per sign-in: later profile edits are the person's choice.
  }, [api, user.id]);

  useEffect(() => {
    void reload();
    void api.drafts().then((drafts) => hydrateDrafts(drafts));
    void Promise.all([api.preferences(), api.chatFolders(), api.pinnedChats()])
      .then(([preferences, chatFolders, pinnedChats]) => {
        notificationPreferences.current = preferences;
        setTheme(preferences.theme);
        setFolders(chatFolders);
        setPinnedChatIDs(pinnedChats);
        setSnoozedUntil(preferences.snoozed_until);
        void setLocale(preferences.locale);
      })
      .catch(() => undefined);
    coordinator.start();
    void outbox.flush();
    return () => {
      coordinator.stop();
      if (reloadTimer.current !== null)
        window.clearTimeout(reloadTimer.current);
      for (const timer of inAppNotificationTimers.current.values())
        window.clearTimeout(timer);
      inAppNotificationTimers.current.clear();
    };
  }, [api, coordinator, outbox, reload]);

  useEffect(() => {
    store.getState().setActive(selectedID);
    coordinator.subscribe(selectedID, threadID);
  }, [coordinator, selectedID, store, threadID]);

  useEffect(() => {
    const key = /^\/m\/([^/]+)$/.exec(path)?.[1];
    if (!key) return;
    try {
      const messageID = expandUUID(key);
      void api
        .messageContext(messageID, 3)
        .then((context) => {
          const target = context.messages.find((item) => item.id === messageID);
          if (!target) throw new Error("message not found");
          navigate(`/chat/${target.chat_id}?message=${messageID}`);
        })
        .catch((cause) => setChatError(messageOf(cause)));
    } catch (cause) {
      setChatError(messageOf(cause));
    }
  }, [api, navigate, path]);

  useEffect(() => {
    const visible = () =>
      coordinator.presence(document.hidden ? "away" : "active");
    // Also on start: the coordinator repeats it after every reconnect.
    visible();
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, [coordinator]);

  useEffect(() => {
    const flush = () => void outbox.flush();
    window.addEventListener("online", flush);
    return () => window.removeEventListener("online", flush);
  }, [outbox]);

  const whenReady = useCallback(() => ready.promise, [ready]);

  const saveFolders = useCallback(
    async (next: ChatFolder[]) => {
      setFolders(await api.putChatFolders(next));
    },
    [api],
  );

  const togglePinnedChat = useCallback(
    async (chatID: string) => {
      if (pinnedChatIDs.includes(chatID)) {
        setPinnedChatIDs(
          await api.putPinnedChats(pinnedChatIDs.filter((id) => id !== chatID)),
        );
        return;
      }
      if (pinnedChatIDs.length >= pinnedChatLimit) {
        setChatError(i18n.t("pinLimit"));
        return;
      }
      setPinnedChatIDs(await api.putPinnedChats([...pinnedChatIDs, chatID]));
    },
    [api, pinnedChatIDs],
  );

  const updateSnooze = useCallback(
    async (until: string | null) => {
      const preferences = await api.updatePreferences({ snoozed_until: until });
      notificationPreferences.current = preferences;
      setSnoozedUntil(preferences.snoozed_until);
      window.dispatchEvent(
        new CustomEvent("coma-preferences-updated", { detail: preferences }),
      );
    },
    [api],
  );

  return {
    store,
    coordinator,
    outbox,
    selectedID,
    threadID,
    reload,
    whenReady,
    scheduleReload,
    chatLoading,
    chatError,
    clearChatError: () => setChatError(""),
    folders,
    saveFolders,
    pinnedChatIDs,
    togglePinnedChat,
    snoozedUntil,
    updateSnooze,
    inAppNotifications,
    dismissInAppNotification,
  };
}
