import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import {
  afterRemind,
  optimisticAnswer,
  requestKeys,
  taskKeys,
  type Message,
  type MessageRequestViewer,
  type RequestState,
} from "@comamessenger/core";
import { useMessenger } from "../shell/MessengerContext";
import { useToast } from "../shell/ToastProvider";
import { requestErrorText } from "./format";

/** Requests being read right now, so cards on screen ask once. */
const loading = new Set<string>();

/**
 * The reader's viewer of one request, from the store's map. When the
 * message came by realtime and no viewer is known yet, it is read once.
 */
export function useRequestViewer(
  message: Pick<Message, "id" | "chat_id" | "request">,
  enabled = true,
): MessageRequestViewer | null {
  const { api, store } = useMessenger();
  const entry = useStore(store, (state) => state.requestViewers[message.id]);
  const hasRequest = Boolean(message.request);
  const missing = !entry || entry.provisional;
  useEffect(() => {
    if (!enabled || !hasRequest || !missing || loading.has(message.id)) return;
    loading.add(message.id);
    void api
      .messageRequest(message.id)
      .then((state) =>
        store.getState().setRequestState(message.id, state, message.chat_id),
      )
      .catch(() => undefined)
      .finally(() => loading.delete(message.id));
  }, [api, enabled, hasRequest, message.chat_id, message.id, missing, store]);
  return entry?.viewer ?? null;
}

/**
 * Answer, close and remind with the cache kept current: an answer shows at
 * once and rolls back with a toast when the server refuses it.
 */
export function useRequestActions(messageID: string, chatID: string) {
  const { t } = useTranslation();
  const { api, store, user, scheduleReload } = useMessenger();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<"answer" | "close" | "remind" | null>(null);

  const settle = useCallback(
    (state: RequestState) => {
      store.getState().setRequestState(messageID, state, chatID);
      void queryClient.invalidateQueries({
        queryKey: [...requestKeys.all(user.id), "inbox"],
      });
      void queryClient.invalidateQueries({
        queryKey: [...taskKeys.all(user.id), "waiting"],
      });
      // What waits for me changed: the strip, the chat mark and the badge.
      scheduleReload();
    },
    [chatID, messageID, queryClient, scheduleReload, store, user.id],
  );

  const answer = useCallback(
    async (option: number, comment?: string) => {
      const before = store.getState().requestEntry(messageID, chatID);
      const expected = before.viewer?.viewer.answer?.version;
      store
        .getState()
        .setRequestEntry(
          messageID,
          optimisticAnswer(before, option, comment, new Date()),
          chatID,
        );
      setBusy("answer");
      try {
        settle(
          await api.answerRequest(messageID, {
            option,
            ...(comment !== undefined ? { comment } : {}),
            ...(expected ? { expected_version: expected } : {}),
          }),
        );
        return true;
      } catch (cause) {
        store.getState().setRequestEntry(messageID, before, chatID);
        toast({ message: requestErrorText(cause), tone: "danger" });
        // Another device changed the answer: show what the server has.
        void api
          .messageRequest(messageID)
          .then(settle)
          .catch(() => undefined);
        return false;
      } finally {
        setBusy(null);
      }
    },
    [api, chatID, messageID, settle, store, toast],
  );

  const close = useCallback(async () => {
    setBusy("close");
    try {
      settle(await api.closeRequest(messageID));
      toast({ message: t("requestClosedToast") });
      return true;
    } catch (cause) {
      toast({ message: requestErrorText(cause), tone: "danger" });
      return false;
    } finally {
      setBusy(null);
    }
  }, [api, messageID, settle, t, toast]);

  const remind = useCallback(async () => {
    setBusy("remind");
    try {
      const result = await api.remindRequest(messageID);
      const entry = store.getState().requestEntry(messageID, chatID);
      if (entry.viewer)
        store.getState().setRequestEntry(
          messageID,
          {
            ...entry,
            viewer: {
              ...entry.viewer,
              viewer: afterRemind(entry.viewer.viewer, result),
            },
          },
          chatID,
        );
      toast({ message: t("requestRemindedToast", { count: result.reminded }) });
      return true;
    } catch (cause) {
      toast({ message: requestErrorText(cause), tone: "danger" });
      void api
        .messageRequest(messageID)
        .then(settle)
        .catch(() => undefined);
      return false;
    } finally {
      setBusy(null);
    }
  }, [api, chatID, messageID, settle, store, t, toast]);

  return { answer, close, remind, busy };
}
