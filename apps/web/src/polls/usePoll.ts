import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import {
  afterPollRemind,
  optimisticPollRetract,
  optimisticPollVote,
  performPollAction,
  pollKeys,
  storePollCache,
  taskKeys,
  type Message,
  type MessagePoll,
  type PollCacheAccess,
  type PollViewer,
} from "@comamessenger/core";
import { useMessenger } from "../shell/MessengerContext";
import { useToast } from "../shell/ToastProvider";
import { anonChoices, pollErrorText } from "./format";

/** Polls being read right now, so cards on screen ask once. */
const loading = new Set<string>();

/**
 * The reader's viewer of one poll from the store. A poll that came by
 * realtime has none yet: it is read once. While the card is on screen the
 * store reads it again after poll.updated (counts are never in frames).
 */
export function usePollViewer(
  message: Pick<Message, "id" | "chat_id" | "poll">,
  enabled = true,
): PollViewer | null {
  const { api, store } = useMessenger();
  const entry = useStore(store, (state) => state.pollViewers[message.id]);
  const hasPoll = Boolean(message.poll);
  useEffect(() => {
    if (!enabled || !hasPoll) return;
    return store.getState().mountPoll(message.id);
  }, [enabled, hasPoll, message.id, store]);
  const missing = !entry;
  useEffect(() => {
    if (!enabled || !hasPoll || !missing || loading.has(message.id)) return;
    loading.add(message.id);
    void api
      .messagePoll(message.id)
      .then((state) =>
        store.getState().setPollState(message.id, state, message.chat_id),
      )
      .catch(() => undefined)
      .finally(() => loading.delete(message.id));
  }, [api, enabled, hasPoll, message.chat_id, message.id, missing, store]);
  return entry?.viewer ?? null;
}

/**
 * The reader's own choice in an anonymous poll, as this device remembers
 * it; null elsewhere or when unknown.
 */
export function useAnonChoice(
  messageID: string,
  poll: Pick<MessagePoll, "anonymous"> | null | undefined,
): number[] | null {
  const { user } = useMessenger();
  const anonymous = Boolean(poll?.anonymous);
  const [choice, setChoice] = useState<number[] | null>(() =>
    anonymous ? (anonChoices.peek(user.id, messageID) ?? null) : null,
  );
  useEffect(() => {
    if (!anonymous) return;
    let live = true;
    void anonChoices.get(user.id, messageID).then((value) => {
      if (live) setChoice(value);
    });
    return () => {
      live = false;
    };
  }, [anonymous, messageID, user.id]);
  // A vote on this device sets it after the first read.
  const peeked = anonymous ? anonChoices.peek(user.id, messageID) : null;
  return peeked ?? choice;
}

export type PollBusy = "vote" | "retract" | "close" | "remind" | null;

/**
 * Vote, retract, close and remind with the cache kept current: a vote shows
 * at once and rolls back with a toast when the server refuses it.
 * `fallback` is the poll as a list item has it, for a poll whose chat is
 * not loaded into the store (Waiting for you).
 */
export function usePollActions(
  message: Pick<Message, "id" | "chat_id" | "actor_id">,
  fallback?: { poll: MessagePoll; viewer: PollViewer } | null,
) {
  const { t } = useTranslation();
  const { api, store, user, scheduleReload } = useMessenger();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<PollBusy>(null);
  const messageID = message.id;
  const chatID = message.chat_id;
  const isAuthor = message.actor_id === user.id;

  const cache = useCallback((): PollCacheAccess => {
    const inner = storePollCache(store, messageID, chatID);
    return {
      read: () => {
        const entry = inner.read();
        return {
          poll: entry.poll ?? fallback?.poll ?? null,
          viewer:
            entry.viewer ??
            (fallback
              ? { viewer: fallback.viewer, version: fallback.poll.version }
              : null),
        };
      },
      write: inner.write,
    };
  }, [chatID, fallback, messageID, store]);

  const settled = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: [...taskKeys.all(user.id), "waiting"],
    });
    void queryClient.invalidateQueries({ queryKey: pollKeys.all(user.id) });
    // Waiting for you, the badge of Important.
    scheduleReload();
  }, [queryClient, scheduleReload, user.id]);

  const reload = useCallback(
    () => api.messagePoll(messageID),
    [api, messageID],
  );

  const vote = useCallback(
    async (options: number[]) => {
      const access = cache();
      const before = access.read();
      setBusy("vote");
      const anonymous = Boolean(before.poll?.anonymous);
      try {
        if (anonymous) await anonChoices.set(user.id, messageID, options);
        await performPollAction(
          access,
          optimisticPollVote(before, options, { isAuthor }),
          () => api.votePoll(messageID, { options }),
          reload,
        );
        settled();
        return true;
      } catch (cause) {
        // The server did not count it: the device must not claim a choice.
        if (anonymous && !before.viewer?.viewer.voted)
          await anonChoices.remove(user.id, messageID);
        toast({ message: pollErrorText(cause), tone: "danger" });
        return false;
      } finally {
        setBusy(null);
      }
    },
    [api, cache, isAuthor, messageID, reload, settled, toast, user.id],
  );

  const retract = useCallback(async () => {
    const access = cache();
    setBusy("retract");
    try {
      await performPollAction(
        access,
        optimisticPollRetract(access.read(), { isAuthor }),
        () => api.retractPollVote(messageID),
        reload,
      );
      // 204 carries no state: read what the server has now.
      void reload()
        .then((state) =>
          store.getState().setPollState(messageID, state, chatID),
        )
        .catch(() => undefined);
      settled();
      return true;
    } catch (cause) {
      toast({ message: pollErrorText(cause), tone: "danger" });
      return false;
    } finally {
      setBusy(null);
    }
  }, [
    api,
    cache,
    chatID,
    isAuthor,
    messageID,
    reload,
    settled,
    store,
    toast,
  ]);

  const close = useCallback(async () => {
    setBusy("close");
    try {
      await performPollAction(
        cache(),
        null,
        () => api.closePoll(messageID),
        reload,
      );
      settled();
      toast({ message: t("pollClosedToast") });
      return true;
    } catch (cause) {
      toast({ message: pollErrorText(cause), tone: "danger" });
      return false;
    } finally {
      setBusy(null);
    }
  }, [api, cache, messageID, reload, settled, t, toast]);

  const remind = useCallback(async () => {
    setBusy("remind");
    try {
      const result = await api.remindPoll(messageID);
      const access = cache();
      const entry = access.read();
      if (entry.viewer)
        access.write({
          ...entry,
          viewer: {
            ...entry.viewer,
            viewer: afterPollRemind(entry.viewer.viewer, result),
          },
        });
      toast({ message: t("pollRemindedToast", { count: result.reminded }) });
      return true;
    } catch (cause) {
      toast({ message: pollErrorText(cause), tone: "danger" });
      void reload()
        .then((state) =>
          store.getState().setPollState(messageID, state, chatID),
        )
        .catch(() => undefined);
      return false;
    } finally {
      setBusy(null);
    }
  }, [api, cache, chatID, messageID, reload, store, t, toast]);

  return { vote, retract, close, remind, busy };
}

export type PollActions = ReturnType<typeof usePollActions>;
