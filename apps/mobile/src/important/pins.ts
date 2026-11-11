import {
  canManageChat,
  type Chat,
  type Message,
  type MessagePin,
} from "@comamessenger/core";

export type ImportantItem = { chat: Chat; message: Message; pin: MessagePin };

/** Chats that have pins, most pins first: the filter tabs of the screen. */
export function chatsWithPins(
  items: ImportantItem[],
): { chat: Chat; count: number }[] {
  const counts = new Map<string, { chat: Chat; count: number }>();
  for (const item of items) {
    const entry = counts.get(item.chat.id) ?? { chat: item.chat, count: 0 };
    entry.count += 1;
    counts.set(item.chat.id, entry);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count);
}

/** Where opening an important message leads: its thread or the chat at it. */
export function importantHref(item: ImportantItem): string {
  const root = item.message.thread_root_id;
  return root
    ? `/chat/${item.chat.id}/thread/${root}`
    : `/chat/${item.chat.id}?message=${item.message.id}`;
}

/** The pinner and chat moderators may unpin, as on the web. */
export function canUnpin(
  item: ImportantItem,
  userID: string,
  permissions: string[],
): boolean {
  return (
    item.pin.pinned_by === userID ||
    permissions.includes("chats.moderate") ||
    canManageChat(item.chat)
  );
}
