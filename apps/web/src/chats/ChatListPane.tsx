import { useEffect, useMemo, useState } from "react";
import { FolderPlus, MessageCircle, Plus, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import type { Chat } from "@comamessenger/core";
import {
  Button,
  Chip,
  EmptyState,
  IconButton,
  InlineError,
  SearchField,
  SkeletonRow,
  cx,
} from "../ui";
import {
  chatFilterFromURL,
  isChatMuted,
  matchesFilter,
  systemChatFilters,
  titleOf,
  writeChatFilterToURL,
  type ChatFilter,
} from "../lib/chats";
import { useIsMobile } from "../lib/useMediaQuery";
import { useMessenger } from "../shell/MessengerContext";
import { Logo } from "../shell/Logo";
import { ConnectionPill } from "../shell/ConnectionPill";
import { ConfirmDialog } from "../dialogs/ConfirmDialog";
import { ChatRow } from "./ChatRow";

function scopeKey(filter: ChatFilter) {
  switch (filter) {
    case "all":
      return "scopeAll";
    case "direct":
      return "scopeDirect";
    case "grouped":
      return "scopeGrouped";
    case "channel":
      return "scopeChannel";
    default:
      return "scopeFolder";
  }
}

export function ChatListPane({
  selectedID,
  loading,
  error,
  onRetry,
}: {
  selectedID: string | null;
  loading: boolean;
  error: string;
  onRetry(): void;
}) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const {
    api,
    user,
    store,
    navigate,
    reload,
    folders,
    saveFolders,
    pinnedChatIDs,
    togglePinnedChat,
    openDialog,
  } = useMessenger();
  const chatMap = useStore(store, (state) => state.chats);
  const unread = useStore(store, (state) => state.unread);
  const presence = useStore(store, (state) => state.presence);
  const realtime = useStore(store, (state) => state.realtime);
  const [filter, setFilter] = useState<ChatFilter>(chatFilterFromURL);
  const [query, setQuery] = useState("");
  const [leaving, setLeaving] = useState<Chat | null>(null);
  const [leavePending, setLeavePending] = useState(false);

  useEffect(() => {
    const listener = (event: Event) =>
      setFilter((event as CustomEvent<ChatFilter>).detail);
    window.addEventListener("coma-chat-filter", listener);
    return () => window.removeEventListener("coma-chat-filter", listener);
  }, []);

  const chats = useMemo(() => Object.values(chatMap), [chatMap]);
  const activeFolder = filter.startsWith("folder:")
    ? folders.find((folder) => `folder:${folder.id}` === filter)
    : undefined;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const pinnedOrder = new Map(pinnedChatIDs.map((id, index) => [id, index]));
  const filtered = chats
    .filter((chat) => {
      if (!matchesFilter(chat, filter, activeFolder?.chat_ids)) return false;
      if (!normalizedQuery) return true;
      return `${titleOf(chat, [], user.id)} ${chat.last_message?.body ?? ""}`
        .toLocaleLowerCase()
        .includes(normalizedQuery);
    })
    .sort((left, right) => {
      const leftPin = pinnedOrder.get(left.id);
      const rightPin = pinnedOrder.get(right.id);
      if (leftPin !== undefined && rightPin !== undefined) return leftPin - rightPin;
      if (leftPin !== undefined) return -1;
      if (rightPin !== undefined) return 1;
      return (right.last_message_at ?? right.created_at).localeCompare(
        left.last_message_at ?? left.created_at,
      );
    });

  function selectFilter(next: ChatFilter) {
    setFilter(next);
    writeChatFilterToURL(next);
  }
  async function toggleFolder(folderID: string, chatID: string) {
    await saveFolders(
      folders.map((folder) =>
        folder.id !== folderID
          ? folder
          : {
              ...folder,
              chat_ids: folder.chat_ids.includes(chatID)
                ? folder.chat_ids.filter((id) => id !== chatID)
                : [...folder.chat_ids, chatID],
            },
      ),
    );
  }
  async function leave() {
    if (!leaving) return;
    setLeavePending(true);
    try {
      await api.removeMember(leaving.id, user.id);
      await reload();
      if (selectedID === leaving.id) navigate("/chats");
      setLeaving(null);
    } finally {
      setLeavePending(false);
    }
  }

  const chips = (
    <div className="chat-list__chips" role="group" aria-label={t("chatFilters")}>
      {systemChatFilters.map((item) => (
        <Chip
          key={item}
          size={isMobile ? "lg" : "md"}
          active={filter === item}
          onClick={() => selectFilter(item)}
        >
          {t(item === "channel" ? "channels" : item)}
        </Chip>
      ))}
      {folders.map((folder) => (
        <Chip
          key={folder.id}
          size={isMobile ? "lg" : "md"}
          active={filter === `folder:${folder.id}`}
          dot={folder.color}
          onClick={() => selectFilter(`folder:${folder.id}`)}
        >
          {folder.name}
        </Chip>
      ))}
      <Chip
        className="ui-chip--icon"
        size={isMobile ? "lg" : "md"}
        aria-label={t("newFolder")}
        title={t("newFolder")}
        onClick={() => openDialog({ kind: "new-folder" })}
      >
        {folders.length ? <Plus strokeWidth={2.2} /> : <FolderPlus />}
      </Chip>
    </div>
  );

  return (
    <aside className="chat-list" aria-label={t("chatNavigation")}>
      <header className="chat-list__head">
        {isMobile ? (
          <div className="chat-list__mobile-bar">
            <Logo size="sm" className="chat-list__workspace-logo" />
            <strong className="truncate">{user.organization_name}</strong>
            <IconButton
              size="icon-lg"
              className="chat-list__mobile-action"
              label={t("search")}
              onClick={() => openDialog({ kind: "search" })}
            >
              <Search />
            </IconButton>
            <IconButton
              size="icon-lg"
              variant="primary"
              className="chat-list__mobile-action"
              label={t("newChat")}
              onClick={() => openDialog({ kind: "new-chat" })}
            >
              <Plus strokeWidth={2.2} />
            </IconButton>
          </div>
        ) : (
          <div className="chat-list__title">
            <h1>{t("chatListTitle")}</h1>
            {!loading && <span className="tabular">{chats.length}</span>}
            <span className="chat-list__spacer" />
            {realtime !== "live" && !loading && (
              <ConnectionPill className="chat-list__connection" />
            )}
            <IconButton
              size="icon-sm"
              className="chat-list__new"
              label={t("newChat")}
              onClick={() => openDialog({ kind: "new-chat" })}
            >
              <Plus strokeWidth={2.2} />
            </IconButton>
          </div>
        )}
        <SearchField
          className="chat-list__search"
          size={isMobile ? "lg" : "md"}
          value={query}
          onChange={setQuery}
          placeholder={t("searchChats")}
          clearLabel={t("clearSearch")}
        />
        {chips}
      </header>
      <div className={cx("chat-list__scroll", loading && "chat-list__scroll--loading")}>
        {error && !loading && (
          <InlineError
            title={t("chatListRefreshFailed")}
            hint={t("chatListRefreshFailedHint")}
            retryLabel={t("retry")}
            onRetry={onRetry}
          />
        )}
        {loading ? (
          <div className="chat-list__skeleton" aria-busy="true">
            {["62%", "48%", "70%", "40%", "55%", "66%", "45%"].map((width, index) => (
              <SkeletonRow
                key={index}
                lines={[width, ["80%", "60%", "90%", "70%", "75%", "55%", "85%"][index]!]}
              />
            ))}
          </div>
        ) : filtered.length ? (
          <div className="chat-list__rows">
            {filtered.map((chat) => {
              const counts = unread.chats.find((item) => item.chat_id === chat.id);
              return (
                <ChatRow
                  key={chat.id}
                  chat={chat}
                  ownID={user.id}
                  selected={chat.id === selectedID}
                  unreadCount={counts?.unread_count ?? 0}
                  mentionCount={counts?.mention_count ?? 0}
                  pinned={pinnedChatIDs.includes(chat.id)}
                  pinnedCount={pinnedChatIDs.length}
                  presence={
                    chat.direct_peer ? presence[chat.direct_peer.actor_id] : undefined
                  }
                  folders={folders}
                  onOpen={() => navigate(`/chat/${chat.id}`)}
                  onTogglePin={() => void togglePinnedChat(chat.id)}
                  onToggleMute={() =>
                    void api
                      .updateChatNotifications(chat.id, {
                        notify_level: isChatMuted(chat) ? "default" : "none",
                        muted_until: null,
                      })
                      .then(() => reload())
                  }
                  onMarkRead={() =>
                    void api.markRead(chat.id, chat.last_activity_seq).then(() => reload())
                  }
                  onToggleFolder={(folderID) => void toggleFolder(folderID, chat.id)}
                  onLeave={() => setLeaving(chat)}
                />
              );
            })}
          </div>
        ) : chats.length === 0 && !error ? (
          <EmptyState
            icon={<MessageCircle />}
            title={t("chatListEmptyTitle")}
            hint={t("chatListEmptyHint")}
            action={
              <Button variant="primary" size="sm" onClick={() => openDialog({ kind: "new-chat" })}>
                {t("newChat")}
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={<Search />}
            title={t("chatListEmptyFilterTitle")}
            hint={
              normalizedQuery
                ? t("chatListEmptyFilterHint", {
                    scope: t(scopeKey(filter), { name: activeFolder?.name ?? "" }),
                    query: query.trim(),
                  })
                : t("chatListEmptyFilterHintNoQuery")
            }
            action={
              normalizedQuery ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    openDialog({ kind: "search", request: { tab: "messages", query: query.trim() } })
                  }
                >
                  {t("searchInMessages")}
                </Button>
              ) : (
                <Button variant="secondary" size="sm" onClick={() => selectFilter("all")}>
                  {t("all")}
                </Button>
              )
            }
          />
        )}
      </div>
      {leaving && (
        <ConfirmDialog
          danger
          title={t("leaveGroupTitle", { name: titleOf(leaving, [], user.id) })}
          description={leaving.kind === "channel" ? t("leaveChannelHint") : t("leaveGroupHint")}
          confirmLabel={
            leaving.kind === "channel" ? t("leaveChannelConfirm") : t("leaveGroupConfirm")
          }
          pending={leavePending}
          onConfirm={() => void leave()}
          onClose={() => setLeaving(null)}
        />
      )}
    </aside>
  );
}
