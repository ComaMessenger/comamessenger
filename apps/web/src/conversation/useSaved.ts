import { useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  applySavedChange,
  isSavedLimitError,
  savedKeys,
} from "@comamessenger/core";
import { useMessenger } from "../shell/MessengerContext";

const noIDs: string[] = [];

/** Ids of the reader's saved messages in a chat: the star in the feed. */
export function useSavedIDs(chatID: string | undefined): Set<string> {
  const { api, user } = useMessenger();
  const query = useQuery({
    queryKey: savedKeys.ids(user.id, chatID ?? ""),
    queryFn: () => api.savedMessageIDs(chatID!),
    enabled: Boolean(chatID),
    staleTime: 5 * 60_000,
  });
  const ids = query.data ?? noIDs;
  return useMemo(() => new Set(ids), [ids]);
}

/** Saves or removes a message from the reader's own «Important». */
export function useSaveMessage() {
  const { api, user } = useMessenger();
  const queryClient = useQueryClient();
  return async (message: { id: string; chat_id: string }, saved: boolean) => {
    if (saved) await api.saveMessage(message.id);
    else await api.unsaveMessage(message.id);
    applySavedChange(queryClient, user.id, {
      messageID: message.id,
      chatID: message.chat_id,
      saved,
    });
  };
}

/** The toast text for a failed save: the limit gets its own explanation. */
export function saveFailureKey(error: unknown): string {
  return isSavedLimitError(error) ? "savedLimitReached" : "actionFailed";
}
