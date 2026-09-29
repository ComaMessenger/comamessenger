import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFocusEffect } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useStore } from "zustand";
import {
  decodeMentions,
  encodeMentions,
  feedRows,
  canManageChat,
  isReadOnly,
  mentionedActorIDs,
  resolvedMentionActorIDs,
  updateMentionText,
  type ClientMessage,
  type MessagePage,
} from "@comamessenger/core";
import { draftStorage } from "@/lib/database";
import { isNetworkError } from "@/lib/errors";
import { cachedMessages, withCache } from "@/messenger/cache";
import { syncDraft } from "@/lib/drafts";
import { useMessenger } from "@/messenger/MessengerProvider";
import { useSignedIn } from "@/session/SessionProvider";

const noMessages: ClientMessage[] = [];

// Focus and blur of stacked screens can arrive in either order; only the
// screen that subscribed last may release the realtime subscription.
let subscriptionOwner: object | null = null;
const typingRepeatMs = 3000;

function sortedUnique(messages: ClientMessage[]) {
  return [
    ...new Map(messages.map((message) => [message.id, message])).values(),
  ].sort((left, right) => left.created_seq - right.created_seq);
}

/**
 * State of one conversation feed — the chat itself or a thread inside it:
 * history and pagination, read markers, drafts, typing and sending.
 */
export function useConversation(chatID: string, threadRootID: string | null) {
  const { api, user } = useSignedIn();
  const { store, coordinator, outbox, scheduleReload } = useMessenger();
  const queryClient = useQueryClient();
  const chat = useStore(store, (state) => state.chats[chatID]);
  const stored = useStore(
    store,
    (state) => state.messages[chatID] ?? noMessages,
  );
  const presence = useStore(store, (state) => state.presence);
  const typingIDs = useStore(store, (state) => state.typing[chatID]);
  const streamsByID = useStore(store, (state) => state.messageStreams);
  const statusesByRun = useStore(store, (state) => state.agentStatuses);
  const membersQuery = useQuery({
    queryKey: ["members", chatID],
    queryFn: () => withCache(`members:${chatID}`, () => api.members(chatID)),
    staleTime: 60_000,
  });
  const members = useMemo(() => membersQuery.data ?? [], [membersQuery.data]);
  const threadKey = ["thread", threadRootID] as const;
  const threadQuery = useQuery({
    queryKey: threadKey,
    queryFn: () => api.thread(threadRootID!),
    enabled: threadRootID !== null,
  });

  const [loading, setLoading] = useState(threadRootID === null);
  const [loadError, setLoadError] = useState(false);
  const [hasOlder, setHasOlder] = useState(false);
  const [unreadAnchor, setUnreadAnchor] = useState(0);
  const loadingOlder = useRef(false);
  const lastReadRequested = useRef(0);
  const lastTyping = useRef(0);

  const messages = useMemo(() => {
    if (threadRootID === null)
      return stored.filter((message) => !message.thread_root_id);
    return sortedUnique([
      ...(threadQuery.data?.messages ?? []),
      ...stored.filter(
        (message) =>
          message.id === threadRootID ||
          message.thread_root_id === threadRootID,
      ),
    ]);
  }, [stored, threadQuery.data, threadRootID]);
  const rows = useMemo(
    () => feedRows(messages, unreadAnchor),
    [messages, unreadAnchor],
  );

  const loadLatest = useCallback(async () => {
    const unread = store.getState().unread;
    const marker =
      threadRootID === null
        ? unread.chats.find((item) => item.chat_id === chatID)
        : unread.threads.find((item) => item.thread_root_id === threadRootID);
    const anchor = marker && marker.unread_count > 0 ? marker.last_read_seq : 0;
    setUnreadAnchor(anchor);
    lastReadRequested.current = marker?.last_read_seq ?? 0;
    if (threadRootID !== null) return;
    setLoadError(false);
    if (!store.getState().messages[chatID]?.length) {
      const saved = await cachedMessages(chatID).catch(() => []);
      if (saved.length && !store.getState().messages[chatID]?.length) {
        store.getState().replaceMessages(chatID, saved);
        setLoading(false);
      }
    }
    try {
      const page = await api.messages(chatID, { limit: 50 });
      store.getState().replaceMessages(chatID, page.messages);
      setHasOlder(page.next_before_seq != null);
    } catch (cause) {
      // Saved messages stay readable offline; the banner explains why.
      if (!(isNetworkError(cause) && store.getState().messages[chatID]?.length))
        setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [api, chatID, store, threadRootID]);

  useEffect(() => {
    void loadLatest();
  }, [loadLatest]);

  useEffect(() => {
    if (threadRootID !== null && threadQuery.data)
      setHasOlder(threadQuery.data.next_before_seq != null);
  }, [threadQuery.data, threadRootID]);

  // The screen on top owns the realtime subscription; returning from a thread
  // hands it back to the chat.
  useFocusEffect(
    useCallback(() => {
      const owner = {};
      subscriptionOwner = owner;
      store.getState().setActive(chatID);
      coordinator.subscribe(chatID, threadRootID);
      return () => {
        coordinator.typing(chatID, false, threadRootID);
        if (subscriptionOwner !== owner) return;
        subscriptionOwner = null;
        store.getState().setActive(null);
        coordinator.subscribe(null, null);
      };
    }, [chatID, coordinator, store, threadRootID]),
  );

  const loadOlder = useCallback(async () => {
    const first = messages.find(
      (message) => message.created_seq < Number.MAX_SAFE_INTEGER,
    );
    if (!hasOlder || loadingOlder.current || !first) return;
    loadingOlder.current = true;
    try {
      if (threadRootID === null) {
        const page = await api.messages(chatID, {
          beforeSeq: first.created_seq,
        });
        store.getState().prependMessages(chatID, page.messages);
        setHasOlder(page.next_before_seq != null);
      } else {
        const page = await api.thread(threadRootID, first.created_seq);
        queryClient.setQueryData<MessagePage>(threadKey, (current) => ({
          messages: sortedUnique([
            ...page.messages,
            ...(current?.messages ?? []),
          ]),
          next_before_seq: page.next_before_seq,
        }));
        setHasOlder(page.next_before_seq != null);
      }
    } finally {
      loadingOlder.current = false;
    }
    // threadKey is derived from threadRootID.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, chatID, hasOlder, messages, queryClient, store, threadRootID]);

  /** Marks everything shown as read; called while the reader is at the bottom. */
  const markRead = useCallback(() => {
    const latest = messages.at(-1)?.created_seq ?? 0;
    if (
      !latest ||
      latest >= Number.MAX_SAFE_INTEGER ||
      latest <= lastReadRequested.current
    )
      return;
    lastReadRequested.current = latest;
    const request =
      threadRootID === null
        ? api.markRead(chatID, latest)
        : api.markThreadRead(threadRootID, latest);
    void request
      .then(() => {
        const unread = store.getState().unread;
        store.getState().setUnread(
          threadRootID === null
            ? {
                ...unread,
                chats: unread.chats.map((item) =>
                  item.chat_id === chatID
                    ? {
                        ...item,
                        unread_count: 0,
                        mention_count: 0,
                        last_read_seq: latest,
                      }
                    : item,
                ),
              }
            : {
                ...unread,
                threads: unread.threads.map((item) =>
                  item.thread_root_id === threadRootID
                    ? { ...item, unread_count: 0, last_read_seq: latest }
                    : item,
                ),
              },
        );
      })
      .catch(() => {
        lastReadRequested.current = 0;
      });
  }, [api, chatID, messages, store, threadRootID]);

  // Drafts: local copy at once, server mirror after a pause in typing.
  const [body, setBody] = useState("");
  const draftLoaded = useRef(false);
  useEffect(() => {
    let active = true;
    void draftStorage.get(chatID, threadRootID).then((draft) => {
      if (!active) return;
      setBody(draft.body);
      draftLoaded.current = true;
    });
    return () => {
      active = false;
    };
  }, [chatID, threadRootID]);
  useEffect(() => {
    if (!draftLoaded.current) return;
    const timer = setTimeout(
      () => void syncDraft(api, chatID, threadRootID, body),
      600,
    );
    return () => clearTimeout(timer);
  }, [api, body, chatID, threadRootID]);

  const changeBody = useCallback(
    (next: string) => {
      setBody(next);
      const now = Date.now();
      if (next && now - lastTyping.current > typingRepeatMs) {
        lastTyping.current = now;
        coordinator.typing(chatID, true, threadRootID);
      } else if (!next) {
        lastTyping.current = 0;
        coordinator.typing(chatID, false, threadRootID);
      }
    },
    [chatID, coordinator, threadRootID],
  );

  const send = useCallback(
    async (replyTo: ClientMessage | null, fileIDs: string[] = []) => {
      const content = body.trim();
      if ((!content && !fileIDs.length) || (chat && isReadOnly(chat))) return;
      setBody("");
      lastTyping.current = 0;
      coordinator.typing(chatID, false, threadRootID);
      await outbox.enqueue(chatID, {
        client_msg_id: crypto.randomUUID(),
        body: content,
        body_format: "markdown",
        reply_to_id: replyTo?.id,
        thread_root_id: threadRootID ?? undefined,
        mentioned_actor_ids: resolvedMentionActorIDs(
          content,
          members,
          presence,
        ),
        file_ids: fileIDs.length ? fileIDs : undefined,
      });
    },
    [body, chat, chatID, coordinator, members, outbox, presence, threadRootID],
  );

  const edit = useCallback(
    async (message: ClientMessage, nextText: string) => {
      const original = decodeMentions(message.body);
      if (!nextText.trim() || nextText === original.text) return;
      const nextBody = encodeMentions(updateMentionText(original, nextText));
      const updated = await api.updateMessage(message.id, {
        body: nextBody,
        body_format: "markdown",
        expected_version: message.version,
        mentioned_actor_ids: mentionedActorIDs(nextBody),
      });
      store.getState().reconcile(updated);
      scheduleReload();
    },
    [api, scheduleReload, store],
  );

  const remove = useCallback(
    async (message: ClientMessage) => {
      store.getState().reconcile(await api.deleteMessage(message.id));
      scheduleReload();
    },
    [api, scheduleReload, store],
  );

  const typingNames = (typingIDs ?? [])
    .filter((id) => id !== user.id)
    .map((id) => members.find((member) => member.actor_id === id)?.display_name)
    .filter((name): name is string => Boolean(name));

  const streams = Object.values(streamsByID).filter(
    (stream) =>
      stream.chatID === chatID && stream.threadRootID === threadRootID,
  );
  const workingAgents = Object.values(statusesByRun).filter(
    (status) =>
      status.chatID === chatID &&
      status.threadRootID === threadRootID &&
      (status.state === "thinking" ||
        status.state === "tool" ||
        status.state === "streaming"),
  );
  const retryOutbox = useCallback(() => void outbox.flush(), [outbox]);

  return {
    chat,
    streams,
    workingAgents,
    members,
    rows,
    messages,
    loading: threadRootID === null ? loading : threadQuery.isPending,
    loadError: threadRootID === null ? loadError : threadQuery.isError,
    retry:
      threadRootID === null ? loadLatest : () => void threadQuery.refetch(),
    hasOlder,
    loadOlder,
    markRead,
    body,
    changeBody,
    setBody,
    send,
    edit,
    remove,
    retryOutbox,
    typingNames,
    readonly: chat ? isReadOnly(chat) : false,
    canModerate:
      user.permissions.includes("chats.moderate") ||
      (chat ? canManageChat(chat) : false),
  };
}
