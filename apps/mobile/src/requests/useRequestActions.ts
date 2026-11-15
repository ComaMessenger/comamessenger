import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  afterRemind,
  optimisticAnswer,
  requestErrorKind,
  requestKeys,
  type MessageRequestViewer,
} from "@comamessenger/core";
import { useMessenger } from "@/messenger/MessengerProvider";
import { useSignedIn } from "@/session/SessionProvider";

/** The toast text for a failed request call. */
export function useRequestErrorText() {
  const { t } = useTranslation();
  return useCallback(
    (error: unknown) =>
      t(`requestError_${requestErrorKind(error)}`, {
        defaultValue: t("requestError_other"),
      }),
    [t],
  );
}

// Requests already read once this session: a card on screen reads its
// viewer (getRequest) when the message came by realtime without one.
const loading = new Set<string>();

/**
 * What a reader does with a request: answer (shown at once, rolled back
 * on an error), comment, remind those who have not answered, close it,
 * and read its state. The store keeps the result for every card of it.
 */
export function useRequestActions(onNotice?: (text: string) => void) {
  const { api, user } = useSignedIn();
  const { store } = useMessenger();
  const queryClient = useQueryClient();
  const errorText = useRequestErrorText();
  const { t } = useTranslation();

  const refreshLists = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: [...requestKeys.all(user.id), "inbox"],
    });
  }, [queryClient, user.id]);

  const load = useCallback(
    (messageID: string, chatID: string) => {
      if (loading.has(messageID)) return;
      loading.add(messageID);
      void api
        .messageRequest(messageID)
        .then((state) =>
          store.getState().setRequestState(messageID, state, chatID),
        )
        .catch(() => loading.delete(messageID));
    },
    [api, store],
  );

  const answer = useCallback(
    async (
      messageID: string,
      chatID: string,
      option: number,
      comment?: string,
    ) => {
      const before = store.getState().requestEntry(messageID, chatID);
      store
        .getState()
        .setRequestEntry(
          messageID,
          optimisticAnswer(before, option, comment, new Date()),
          chatID,
        );
      try {
        const state = await api.answerRequest(messageID, {
          option,
          ...(comment !== undefined ? { comment } : {}),
        });
        store.getState().setRequestState(messageID, state, chatID);
        refreshLists();
        return true;
      } catch (error) {
        store.getState().setRequestEntry(messageID, before, chatID);
        onNotice?.(errorText(error));
        // The state moved on elsewhere (closed, too late): show it as it is.
        loading.delete(messageID);
        load(messageID, chatID);
        return false;
      }
    },
    [api, errorText, load, onNotice, refreshLists, store],
  );

  const remind = useCallback(
    async (messageID: string, chatID: string) => {
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
        onNotice?.(t("requestReminded", { count: result.reminded }));
        return result;
      } catch (error) {
        onNotice?.(errorText(error));
        return null;
      }
    },
    [api, errorText, onNotice, store, t],
  );

  const close = useCallback(
    async (messageID: string, chatID: string) => {
      try {
        const state = await api.closeRequest(messageID);
        store.getState().setRequestState(messageID, state, chatID);
        refreshLists();
        onNotice?.(t("requestClosedNotice"));
        return true;
      } catch (error) {
        onNotice?.(errorText(error));
        return false;
      }
    },
    [api, errorText, onNotice, refreshLists, store, t],
  );

  return { load, answer, remind, close };
}

export type ViewerLike = MessageRequestViewer | null | undefined;
