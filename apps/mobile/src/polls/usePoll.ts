import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import {
  afterPollRemind,
  optimisticPollRetract,
  optimisticPollVote,
  performPollAction,
  storePollCache,
  type Message,
  type MessagePoll,
  type PollCacheAccess,
  type PollViewer,
} from "@comamessenger/core";
import { useMessenger } from "@/messenger/MessengerProvider";
import { useSignedIn } from "@/session/SessionProvider";
import { anonChoices, pollErrorText } from "./format";
import { invalidatePollLists } from "./lists";

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
  const { api } = useSignedIn();
  const { store } = useMessenger();
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
  const { user } = useSignedIn();
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

export type PollActions = {
  vote(options: number[]): Promise<boolean>;
  retract(): Promise<boolean>;
  close(): Promise<boolean>;
  remind(): Promise<boolean>;
  busy: PollBusy;
};

/**
 * Vote, retract, close and remind with the cache kept current: a vote shows
 * at once and rolls back with a notice when the server refuses it.
 * `fallback` is the poll as a list item has it, for a poll whose chat is
 * not loaded into the store («Ждут вас»).
 */
export function usePollActions(
  message: Pick<Message, "id" | "chat_id" | "actor_id">,
  onNotice: ((text: string) => void) | undefined,
  fallback?: { poll: MessagePoll; viewer: PollViewer } | null,
): PollActions {
  const { t } = useTranslation();
  const { api, user } = useSignedIn();
  const { store, scheduleReload } = useMessenger();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<PollBusy>(null);
  const messageID = message.id;
  const chatID = message.chat_id;
  const isAuthor = message.actor_id === user.id;
  const notice = useCallback((text: string) => onNotice?.(text), [onNotice]);

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
    invalidatePollLists(queryClient, user.id);
    // «Ждут вас» and the badge of «Важные» count from /unread.
    scheduleReload();
  }, [queryClient, scheduleReload, user.id]);

  const reload = useCallback(
    () => api.messagePoll(messageID),
    [api, messageID],
  );
  const readAgain = useCallback(
    () =>
      void reload()
        .then((state) =>
          store.getState().setPollState(messageID, state, chatID),
        )
        .catch(() => undefined),
    [chatID, messageID, reload, store],
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
        notice(pollErrorText(t, cause));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [api, cache, isAuthor, messageID, notice, reload, settled, t, user.id],
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
      readAgain();
      settled();
      return true;
    } catch (cause) {
      notice(pollErrorText(t, cause));
      return false;
    } finally {
      setBusy(null);
    }
  }, [api, cache, isAuthor, messageID, notice, readAgain, reload, settled, t]);

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
      notice(t("pollClosedToast"));
      return true;
    } catch (cause) {
      notice(pollErrorText(t, cause));
      return false;
    } finally {
      setBusy(null);
    }
  }, [api, cache, messageID, notice, reload, settled, t]);

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
      notice(t("pollRemindedToast", { count: result.reminded }));
      return true;
    } catch (cause) {
      notice(pollErrorText(t, cause));
      readAgain();
      return false;
    } finally {
      setBusy(null);
    }
  }, [api, cache, messageID, notice, readAgain, t]);

  return { vote, retract, close, remind, busy };
}
