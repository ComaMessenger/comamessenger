import type { Chat, ChatFilter, ChatMember } from "@comamessenger/core";
import i18n from "../i18n";

export {
  canManageChat,
  isChatMuted,
  isReadOnly,
  matchesFilter,
  systemChatFilters,
  type ChatFilter,
  type SystemChatFilter,
} from "@comamessenger/core";

export function titleOf(chat?: Chat, members: ChatMember[] = [], ownID = "") {
  if (!chat) return "Coma";
  return (
    chat.display_name ||
    chat.name ||
    members.find((item) => item.actor_id !== ownID)?.display_name ||
    i18n.t("directChat")
  );
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
