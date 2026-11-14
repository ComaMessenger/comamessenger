import type {
  ChatSharedAttachment,
  ChatSharedAttachmentPage,
  ChatSharedLink,
  ChatSharedLinkPage,
  DurableEvent,
} from "./types";

/**
 * Shared media of a chat: the «Медиа», «Файлы», «Голосовые» and «Ссылки»
 * tabs of chat info, read page by page from the server (newest first) and
 * shared by the web and the phone. The server decides what a reader sees: a
 * write-only agent its own messages only, nobody deleted messages.
 */
export type SharedTab = "media" | "files" | "voice" | "links";
export type SharedAttachmentKind = Exclude<SharedTab, "links">;

export const sharedTabs: readonly SharedTab[] = [
  "media",
  "files",
  "voice",
  "links",
];

/** Page size of a tab: a media grid of 3–4 columns fills a phone screen. */
export const sharedPageSize = 60;

export const sharedKeys = {
  /** Everything shared of one chat: invalidate this after a change. */
  all: (chatID: string) => ["chat-shared", chatID] as const,
  counts: (chatID: string) => ["chat-shared", chatID, "counts"] as const,
  tab: (chatID: string, tab: SharedTab) =>
    ["chat-shared", chatID, "tab", tab] as const,
};

/** For TanStack `getNextPageParam`: the opaque cursor or the end. */
export function sharedNextCursor(
  page: ChatSharedAttachmentPage | ChatSharedLinkPage,
): string | undefined {
  return page.next_cursor ?? undefined;
}

/** All loaded items of a tab, pages in order, each item once. */
export function sharedItems<T extends ChatSharedAttachment | ChatSharedLink>(
  pages: readonly { items: readonly T[] }[] | undefined,
): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const page of pages ?? []) {
    for (const item of page.items) {
      const key = sharedItemKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

/** A stable key: a file appears once per message, a link once too. */
export function sharedItemKey(
  item: ChatSharedAttachment | ChatSharedLink,
): string {
  return "file" in item
    ? `${item.message_id}:${item.file.id}`
    : `${item.message_id}:${item.url}`;
}

export type SharedMonth<T> = {
  /** `YYYY-MM` in the reader's time zone. */
  key: string;
  /** «Ноябрь» this year, «Ноябрь 2025» before. */
  label: string;
  items: T[];
};

/**
 * Groups items (newest first) by month of sending, as Telegram does above a
 * media grid. Items keep their order; months follow it.
 */
export function groupSharedByMonth<T extends { created_at: string }>(
  items: readonly T[],
  locale: string,
  now: Date = new Date(),
): SharedMonth<T>[] {
  const result: SharedMonth<T>[] = [];
  for (const item of items) {
    const date = new Date(item.created_at);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    const last = result.at(-1);
    if (last?.key === key) {
      last.items.push(item);
      continue;
    }
    result.push({ key, label: sharedMonthLabel(date, locale, now), items: [item] });
  }
  return result;
}

export function sharedMonthLabel(
  date: Date,
  locale: string,
  now: Date = new Date(),
): string {
  const month = new Intl.DateTimeFormat(locale, { month: "long" }).format(date);
  const label =
    date.getFullYear() === now.getFullYear()
      ? month
      : `${month} ${date.getFullYear()}`;
  return label.charAt(0).toLocaleUpperCase(locale) + label.slice(1);
}

/** Whether an attachment plays as a video (grid tile with a play mark). */
export function isSharedVideo(item: ChatSharedAttachment): boolean {
  return item.file.mime.startsWith("video/");
}

/** Where opening an item leads: the message in its thread or in the chat. */
export function sharedMessageTarget(
  item: ChatSharedAttachment | ChatSharedLink,
): { messageID: string; threadRootID: string | null } {
  return { messageID: item.message_id, threadRootID: item.thread_root_id };
}

/**
 * Whether a realtime event changes the shared media of a chat: a new, edited
 * or deleted message may add or drop files and links. Returns the chat to
 * refresh, or null.
 */
export function sharedChangedChat(event: DurableEvent): string | null {
  if (
    event.type !== "message.created" &&
    event.type !== "message.updated" &&
    event.type !== "message.deleted"
  )
    return null;
  return event.chat_id ?? null;
}

/** Pages with every item of one message removed: a deletion seen live. */
export function withoutSharedMessage<
  P extends { items: readonly (ChatSharedAttachment | ChatSharedLink)[] },
>(pages: readonly P[], messageID: string): P[] {
  return pages.map((page) => ({
    ...page,
    items: page.items.filter((item) => item.message_id !== messageID),
  }));
}
