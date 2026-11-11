import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useStore } from "zustand";
import { useMessenger } from "@/messenger/MessengerProvider";
import { useSignedIn } from "@/session/SessionProvider";
import type { ImportantItem } from "./pins";

export type { ImportantItem };

export const importantKey = ["important"] as const;

/**
 * Messages pinned in every chat the person is in, newest pin first — the
 * same source as «Important» on the web.
 */
export function useImportant() {
  const { api } = useSignedIn();
  const { store } = useMessenger();
  const chatMap = useStore(store, (state) => state.chats);
  const chats = useMemo(() => Object.values(chatMap), [chatMap]);
  const chatKey = chats
    .map((chat) => chat.id)
    .sort()
    .join(":");
  return useQuery({
    queryKey: [...importantKey, chatKey],
    enabled: chats.length > 0,
    queryFn: async (): Promise<ImportantItem[]> => {
      const pinned = (
        await Promise.all(
          chats.map(async (chat) =>
            (await api.pins(chat.id)).map((pin) => ({ chat, pin })),
          ),
        )
      ).flat();
      const resolved = await Promise.all(
        pinned.map(async ({ chat, pin }) => {
          const context = await api.messageContext(pin.message_id, 1);
          const message = context.messages.find(
            (item) => item.id === pin.message_id,
          );
          return message ? { chat, message, pin } : null;
        }),
      );
      const seen = new Set<string>();
      return resolved
        .filter((item): item is ImportantItem => Boolean(item))
        .filter((item) => {
          if (seen.has(item.message.id)) return false;
          seen.add(item.message.id);
          return true;
        })
        .sort((left, right) =>
          right.pin.pinned_at.localeCompare(left.pin.pinned_at),
        );
    },
  });
}
