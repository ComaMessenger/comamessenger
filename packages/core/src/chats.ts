import { messagePlainText } from "./mentions";
import type { Chat } from "./types";

export type SystemChatFilter = "all" | "direct" | "grouped" | "channel";
export type ChatFilter = SystemChatFilter | `folder:${string}`;

export const systemChatFilters: SystemChatFilter[] = [
  "all",
  "direct",
  "grouped",
  "channel",
];

export function isChatMuted(chat: Chat, now = Date.now()) {
  return (
    chat.notify_level === "none" ||
    Boolean(chat.muted_until && new Date(chat.muted_until).getTime() > now)
  );
}

export function isReadOnly(chat: Chat) {
  return chat.kind === "channel" && chat.role === "member";
}

export function canManageChat(chat: Chat) {
  return chat.kind !== "direct" && chat.role !== "member";
}

export function matchesFilter(
  chat: Chat,
  filter: ChatFilter,
  folderChatIDs: string[] | undefined,
) {
  switch (filter) {
    case "all":
      return true;
    case "direct":
      return chat.kind === "direct";
    case "grouped":
      return chat.kind === "group";
    case "channel":
      return chat.kind === "channel";
    default:
      return folderChatIDs?.includes(chat.id) ?? false;
  }
}

export type ChatPreviewLabels = {
  you: string;
  deleted: string;
  attachment: string;
};

/** Last-message line of a chat row, split so the sender can be styled apart. */
export function chatPreview(
  chat: Chat,
  ownID: string,
  labels: ChatPreviewLabels,
): { sender: string; text: string } {
  const last = chat.last_message;
  if (!last) return { sender: "", text: chat.topic };
  if (last.deleted) return { sender: "", text: labels.deleted };
  const text = messagePlainText(last.body).trim() || labels.attachment;
  if (chat.kind === "direct")
    return { sender: last.actor_id === ownID ? `${labels.you}: ` : "", text };
  const name = last.actor_id === ownID ? labels.you : last.actor_display_name;
  return { sender: name ? `${name}: ` : "", text };
}

/** Compact time for list rows: today → HH:MM, this week → weekday, else → D MMM. */
export function formatListTime(
  value: string,
  locale: string,
  yesterday: string,
  now = new Date(),
) {
  const date = new Date(value);
  if (date.toDateString() === now.toDateString())
    return new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  const previousDay = new Date(now);
  previousDay.setDate(now.getDate() - 1);
  if (date.toDateString() === previousDay.toDateString()) return yesterday;
  const days = (now.getTime() - date.getTime()) / 86_400_000;
  if (days < 7)
    return new Intl.DateTimeFormat(locale, { weekday: "short" }).format(date);
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  }).format(date);
}

/** Two letters for an avatar: first letters of two words, or two of one word. */
export function initialsOf(name: string) {
  const words = name
    .trim()
    .split(/[\s-]+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word));
  if (words.length === 0) return "";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return words
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}
