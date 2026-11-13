import { useCallback, useState } from "react";
import { Alert } from "react-native";
import { useTranslation } from "react-i18next";
import {
  directChatRequest,
  findDirectChat,
  type MessengerAPI,
} from "@comamessenger/core";
import type { MessengerStore } from "@/messenger/MessengerProvider";
import { useMessenger } from "@/messenger/MessengerProvider";
import { useSignedIn } from "@/session/SessionProvider";
import { messageOf } from "@/lib/errors";

/**
 * The direct chat with an actor: the one the reader already has, or a new
 * one. The server also returns the existing chat for the same pair, so a
 * stale list never produces a duplicate.
 */
export async function openDirectChat(
  api: MessengerAPI,
  store: MessengerStore,
  actorID: string,
): Promise<string> {
  const existing = findDirectChat(
    Object.values(store.getState().chats),
    actorID,
  );
  if (existing) return existing.id;
  const chat = await api.createChat(directChatRequest(actorID));
  store.setState((state) => ({ chats: { ...state.chats, [chat.id]: chat } }));
  return chat.id;
}

/** Opens the direct chat; `opening` is the actor being opened, for a spinner. */
export function useOpenDirect(navigate: (chatID: string) => void) {
  const { t } = useTranslation();
  const { api } = useSignedIn();
  const { store, scheduleReload } = useMessenger();
  const [opening, setOpening] = useState<string | null>(null);
  const open = useCallback(
    async (actorID: string) => {
      if (opening) return;
      setOpening(actorID);
      try {
        const chatID = await openDirectChat(api, store, actorID);
        scheduleReload();
        navigate(chatID);
      } catch (cause) {
        Alert.alert(t("directOpenFailed"), messageOf(cause));
      } finally {
        setOpening(null);
      }
    },
    [api, navigate, opening, scheduleReload, store, t],
  );
  return { open, opening };
}
