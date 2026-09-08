import type { Chat, ChatMember } from "@comamessenger/core";
import i18n from "../i18n";

export type SystemChatFilter = "all" | "direct" | "grouped" | "channel";
export type ChatFilter = SystemChatFilter | `folder:${string}`;

export const systemChatFilters: SystemChatFilter[] = [
  "all",
  "direct",
  "grouped",
  "channel",
];

export function titleOf(chat?: Chat, members: ChatMember[] = [], ownID = "") {
  if (!chat) return "Coma";
  return (
    chat.display_name ||
    chat.name ||
    members.find((item) => item.actor_id !== ownID)?.display_name ||
    i18n.t("directChat")
  );
}

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

export function chatFilterFromURL(): ChatFilter {
  const search = new URLSearchParams(window.location.search);
  const folder = search.get("folder");
  if (folder) return `folder:${folder}`;
  const value = search.get("filter");
  return value === "direct" || value === "grouped" || value === "channel"
    ? value
    : "all";
}

export function writeChatFilterToURL(next: ChatFilter) {
  const url = new URL(window.location.href);
  url.searchParams.delete("folder");
  if (next.startsWith("folder:")) {
    url.searchParams.delete("filter");
    url.searchParams.set("folder", next.slice("folder:".length));
  } else if (next === "all") url.searchParams.delete("filter");
  else url.searchParams.set("filter", next);
  window.history.replaceState(window.history.state, "", url);
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

/** Channels show a hash instead of initials. */
export function chatGlyph(chat?: Chat) {
  return chat?.kind === "channel" ? "#" : undefined;
}

export function chatKindLabel(chat: Chat) {
  return chat.kind === "direct"
    ? i18n.t("direct")
    : chat.kind === "group"
      ? i18n.t("group")
      : i18n.t("channel");
}
