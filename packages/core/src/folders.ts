import { matchesFilter, type SystemChatFilter } from "./chats";
import type { Chat, ChatFolder, UnreadSnapshot } from "./types";

type ChatUnread = UnreadSnapshot["chats"][number];

/** Chats a person may pin across devices (`PUT /preferences/pinned-chats`). */
export const pinnedChatLimit = 10;

/** Limits of `ChatFolder` in the contract. */
export const folderNameMaxLength = 40;
export const folderChatLimit = 200;

/** Folder colours in the order the pickers show them. */
export const folderColors: ChatFolder["color"][] = [
  "blue",
  "green",
  "amber",
  "red",
  "violet",
  "teal",
  "orange",
  "pink",
  "cyan",
  "slate",
];

/** Theme token of a folder colour, e.g. `folderBlue`. */
export function folderColorToken(
  color: ChatFolder["color"],
): `folder${Capitalize<ChatFolder["color"]>}` {
  return `folder${(color.charAt(0).toUpperCase() + color.slice(1)) as Capitalize<ChatFolder["color"]>}`;
}

/**
 * A tab of the chat list: every chat, chats with something unread, one kind
 * of chat, or a folder the person made.
 */
export type ChatListTab = SystemChatFilter | "unread" | `folder:${string}`;

export function folderTab(folderID: string): ChatListTab {
  return `folder:${folderID}`;
}

export function unreadByChat(unread: UnreadSnapshot): Map<string, ChatUnread> {
  return new Map(unread.chats.map((item) => [item.chat_id, item]));
}

export function hasUnread(count: ChatUnread | undefined): boolean {
  return Boolean(count && (count.unread_count > 0 || count.mention_count > 0));
}

/** The folder a tab points at, or undefined for built-in tabs and deleted folders. */
export function folderOfTab(
  tab: ChatListTab,
  folders: ChatFolder[],
): ChatFolder | undefined {
  if (!tab.startsWith("folder:")) return undefined;
  const id = tab.slice("folder:".length);
  return folders.find((folder) => folder.id === id);
}

/** A folder tab whose folder is gone falls back to «All». */
export function resolveTab(
  tab: ChatListTab,
  folders: ChatFolder[],
): ChatListTab {
  return tab.startsWith("folder:") && !folderOfTab(tab, folders) ? "all" : tab;
}

export function matchesTab(
  chat: Chat,
  tab: ChatListTab,
  folders: ChatFolder[],
  counts: Map<string, ChatUnread>,
): boolean {
  if (tab === "unread") return hasUnread(counts.get(chat.id));
  if (tab.startsWith("folder:"))
    return matchesFilter(chat, tab, folderOfTab(tab, folders)?.chat_ids);
  return matchesFilter(chat, tab as SystemChatFilter, undefined);
}

/** Unread messages in the chats of a tab; the sum the tab shows. */
export function tabUnreadCount(
  chats: Chat[],
  tab: ChatListTab,
  folders: ChatFolder[],
  counts: Map<string, ChatUnread>,
): number {
  let total = 0;
  for (const chat of chats)
    if (matchesTab(chat, tab, folders, counts))
      total += counts.get(chat.id)?.unread_count ?? 0;
  return total;
}

/** Unread messages in chats the person is still in; the «Chats» tab badge. */
export function totalUnread(
  unread: UnreadSnapshot,
  chats: Record<string, Chat>,
): number {
  return unread.chats.reduce(
    (sum, item) => (chats[item.chat_id] ? sum + item.unread_count : sum),
    0,
  );
}

/** Pinned chats first in the order they were pinned, then by last activity. */
export function sortChats(chats: Chat[], pinnedChatIDs: string[]): Chat[] {
  const pinned = new Map(pinnedChatIDs.map((id, index) => [id, index]));
  return [...chats].sort((left, right) => {
    const leftPin = pinned.get(left.id) ?? Infinity;
    const rightPin = pinned.get(right.id) ?? Infinity;
    if (leftPin !== rightPin) return leftPin - rightPin;
    return (right.last_message_at ?? right.created_at).localeCompare(
      left.last_message_at ?? left.created_at,
    );
  });
}

/** Adds the chat to the folder or takes it out. */
export function toggleChatInFolder(
  folders: ChatFolder[],
  folderID: string,
  chatID: string,
): ChatFolder[] {
  return folders.map((folder) =>
    folder.id !== folderID
      ? folder
      : {
          ...folder,
          chat_ids: folder.chat_ids.includes(chatID)
            ? folder.chat_ids.filter((id) => id !== chatID)
            : [...folder.chat_ids, chatID],
        },
  );
}

/** Replaces a folder with the same id or appends a new one at the end. */
export function upsertFolder(
  folders: ChatFolder[],
  folder: ChatFolder,
): ChatFolder[] {
  return folders.some((item) => item.id === folder.id)
    ? folders.map((item) => (item.id === folder.id ? folder : item))
    : [...folders, folder];
}

export function removeFolder(
  folders: ChatFolder[],
  folderID: string,
): ChatFolder[] {
  return folders.filter((folder) => folder.id !== folderID);
}

/** Moves a folder one place towards the start (-1) or the end (1); edges stay put. */
export function moveFolder(
  folders: ChatFolder[],
  folderID: string,
  offset: -1 | 1,
): ChatFolder[] {
  const index = folders.findIndex((folder) => folder.id === folderID);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= folders.length) return folders;
  const next = [...folders];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}
