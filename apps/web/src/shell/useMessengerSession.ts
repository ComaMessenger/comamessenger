import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MessengerAPI,
  Outbox,
  RealtimeCoordinator,
  createMessengerStore,
  expandUUID,
  messagePlainText,
  type Chat,
  type ChatFolder,
  type DurableEvent,
  type User,
  type UserPreferences,
} from "@comamessenger/core";
import i18n, { setLocale } from "../i18n";
import { checkpointStorage, outboxStorage } from "../persistence";
import { setTheme } from "../theme";
import { messageOf } from "../errors";
import { hydrateDrafts } from "../lib/drafts";
import {
  playNotificationSound,
  shouldPlayNotificationSound,
  shouldShowInAppNotification,
  unlockNotificationSound,
} from "../notificationSound";

export type InAppNotification = {
  id: string;
  title: string;
  body: string;
  url: string;
  avatarName: string;
  avatarSeed: string;
  mention: boolean;
};

export const pinnedChatLimit = 10;

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
  const store = useMemo(() => createMessengerStore(), []);
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
    (event: DurableEvent, chat: Chat | undefined) => {
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
      const notification: InAppNotification = {
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
              (event.type.startsWith("chat.") ||
                event.type.startsWith("member.") ||
                event.type.startsWith("message."))
            )
              scheduleReload();
            if (profileEvent) scheduleReload();
            return applied || profileEvent;
          },
          resync: async (watermark) => {
            const active = store.getState().activeChatID;
            store.getState().resetDurable(watermark);
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
          ephemeralReset: () => store.getState().clearAgentEphemeral(),
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
      reload,
      scheduleReload,
      showInAppNotification,
      store,
      user,
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
