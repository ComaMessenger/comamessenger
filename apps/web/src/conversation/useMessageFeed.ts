import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useStore } from "zustand";
import type { ClientMessage, MessengerAPI } from "@comamessenger/core";
import type { MessengerStore } from "../shell/MessengerContext";

const emptyMessages: ClientMessage[] = [];

/**
 * Loads history for a chat, keeps the scroll anchored (read boundary on open,
 * bottom while following), marks messages read and paginates upwards.
 */
export function useMessageFeed({
  api,
  store,
  chatID,
  scroller,
  whenReady,
}: {
  api: MessengerAPI;
  store: MessengerStore;
  chatID: string;
  scroller: RefObject<HTMLDivElement | null>;
  whenReady(): Promise<void>;
}) {
  const messages = useStore(store, (state) => state.messages[chatID] ?? emptyMessages);
  const [hasMore, setHasMore] = useState(true);
  const [loadingPrevious, setLoadingPrevious] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [newBelow, setNewBelow] = useState(0);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const [feedReady, setFeedReady] = useState(false);
  const [unreadAnchor, setUnreadAnchor] = useState(0);
  const loadingPreviousRef = useRef(false);
  const atBottom = useRef(true);
  const initialPositioned = useRef(false);
  const pendingInitialPosition = useRef<{
    chatID: string;
    hasUnread: boolean;
    lastReadSeq: number;
  } | null>(null);
  const previousVisibleLength = useRef(0);
  const lastReadRequested = useRef(0);

  const visible = messages.filter((item) => !item.thread_root_id);
  const virtual = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 68,
    overscan: 12,
  });

  useEffect(() => {
    initialPositioned.current = false;
    previousVisibleLength.current = 0;
    pendingInitialPosition.current = null;
    atBottom.current = true;
    setNewBelow(0);
    setShowScrollDown(false);
    setFeedReady(false);
    setLoadError(false);
    let active = true;
    setHasMore(true);
    void Promise.all([api.messages(chatID, { limit: 50 }), whenReady()])
      .then(([page]) => {
        if (!active) return;
        const unread = store
          .getState()
          .unread.chats.find((item) => item.chat_id === chatID);
        const lastReadSeq = unread?.last_read_seq ?? 0;
        setUnreadAnchor(lastReadSeq);
        lastReadRequested.current = lastReadSeq;
        pendingInitialPosition.current = {
          chatID,
          hasUnread: Boolean(unread?.unread_count),
          lastReadSeq,
        };
        store.getState().replaceMessages(chatID, page.messages);
        setHasMore(page.next_before_seq != null);
        if (page.messages.length === 0) {
          initialPositioned.current = true;
          setFeedReady(true);
        }
      })
      .catch(() => {
        if (!active) return;
        setLoadError(true);
        setFeedReady(true);
      });
    return () => {
      active = false;
    };
  }, [api, chatID, store, whenReady]);

  const latestSeq = visible.at(-1)?.created_seq ?? 0;
  const markLatestRead = useCallback(() => {
    if (
      !latestSeq ||
      latestSeq >= Number.MAX_SAFE_INTEGER ||
      latestSeq <= lastReadRequested.current
    )
      return;
    lastReadRequested.current = latestSeq;
    void api
      .markRead(chatID, latestSeq)
      .then(() =>
        store.getState().setUnread({
          ...store.getState().unread,
          chats: store.getState().unread.chats.map((item) =>
            item.chat_id === chatID
              ? { ...item, unread_count: 0, mention_count: 0, last_read_seq: latestSeq }
              : item,
          ),
        }),
      )
      .catch(() => {
        if (lastReadRequested.current === latestSeq)
          lastReadRequested.current = unreadAnchor;
      });
  }, [api, chatID, latestSeq, store, unreadAnchor]);

  useEffect(() => {
    const pending = pendingInitialPosition.current;
    if (!pending || pending.chatID !== chatID || !visible.length) return;
    pendingInitialPosition.current = null;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const element = scroller.current;
        if (!element) return;
        const finishPositioning = () => {
          const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
          atBottom.current = distance < 64;
          setShowScrollDown(!atBottom.current);
          initialPositioned.current = true;
          setFeedReady(true);
          if (atBottom.current) markLatestRead();
        };
        if (pending.hasUnread) {
          let lastReadIndex = -1;
          for (let index = visible.length - 1; index >= 0; index -= 1) {
            if (visible[index]!.created_seq <= pending.lastReadSeq) {
              lastReadIndex = index;
              break;
            }
          }
          const targetIndex = Math.max(0, lastReadIndex);
          const targetID = visible[targetIndex]!.id;
          virtual.scrollToIndex(targetIndex, {
            align: pending.lastReadSeq > 0 ? "center" : "start",
          });
          requestAnimationFrame(() => {
            document.getElementById(`message-${targetID}`)?.scrollIntoView({ block: "center" });
            requestAnimationFrame(finishPositioning);
          });
        } else {
          element.scrollTop = element.scrollHeight;
          requestAnimationFrame(finishPositioning);
        }
      }),
    );
  }, [chatID, markLatestRead, scroller, virtual, visible]);

  useEffect(() => {
    const previous = previousVisibleLength.current;
    previousVisibleLength.current = visible.length;
    if (!initialPositioned.current || visible.length <= previous) return;
    const added = visible.length - previous;
    if (atBottom.current)
      requestAnimationFrame(() => {
        const element = scroller.current;
        if (!element) return;
        element.scrollTo({ top: element.scrollHeight });
        markLatestRead();
      });
    else {
      setNewBelow((value) => value + added);
      setShowScrollDown(true);
    }
  }, [markLatestRead, scroller, visible.length]);

  useEffect(() => {
    const target = new URLSearchParams(window.location.search).get("message");
    if (!target) return;
    void api.messageContext(target).then((window) => {
      store.getState().replaceMessages(chatID, window.messages);
      requestAnimationFrame(() =>
        document.getElementById(`message-${target}`)?.scrollIntoView({ block: "center" }),
      );
    });
  }, [api, chatID, store]);

  async function loadPrevious() {
    if (loadingPreviousRef.current || !hasMore) return;
    const first = visible.find((item) => item.created_seq < Number.MAX_SAFE_INTEGER);
    if (!first) return;
    loadingPreviousRef.current = true;
    setLoadingPrevious(true);
    const previousHeight = scroller.current?.scrollHeight ?? 0;
    try {
      const page = await api.messages(chatID, { beforeSeq: first.created_seq });
      store.getState().prependMessages(chatID, page.messages);
      setHasMore(page.next_before_seq != null);
      requestAnimationFrame(() => {
        if (scroller.current)
          scroller.current.scrollTop += scroller.current.scrollHeight - previousHeight;
      });
    } finally {
      loadingPreviousRef.current = false;
      setLoadingPrevious(false);
    }
  }

  async function jump(messageID: string) {
    const window = await api.messageContext(messageID);
    store.getState().replaceMessages(chatID, window.messages);
    requestAnimationFrame(() =>
      document.getElementById(`message-${messageID}`)?.scrollIntoView({ block: "center" }),
    );
  }

  function onScroll(element: HTMLDivElement) {
    if (element.scrollTop < 96) void loadPrevious();
    atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 64;
    setShowScrollDown(!atBottom.current);
    if (atBottom.current) {
      setNewBelow(0);
      markLatestRead();
    }
  }

  function scrollToBottom() {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
    setNewBelow(0);
  }

  function retryInitial() {
    setLoadError(false);
    setFeedReady(false);
    void api
      .messages(chatID, { limit: 50 })
      .then((page) => {
        pendingInitialPosition.current = { chatID, hasUnread: false, lastReadSeq: unreadAnchor };
        store.getState().replaceMessages(chatID, page.messages);
        setHasMore(page.next_before_seq != null);
        if (page.messages.length === 0) setFeedReady(true);
      })
      .catch(() => {
        setLoadError(true);
        setFeedReady(true);
      });
  }

  return {
    messages,
    visible,
    virtual,
    hasMore,
    loadingPrevious,
    loadError,
    newBelow,
    showScrollDown,
    feedReady,
    unreadAnchor,
    onScroll,
    scrollToBottom,
    jump,
    retryInitial,
  };
}
