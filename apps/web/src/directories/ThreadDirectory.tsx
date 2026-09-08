import { useMemo, useState } from "react";
import { MessagesSquare, RefreshCw } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { messagePlainText, type ChatMember, type Message, type ThreadSummary } from "@comamessenger/core";
import { Avatar, Badge, Chip, EmptyState, IconButton, InlineError, SkeletonRow, countLabel } from "../ui";
import { formatAge } from "../lib/format";
import { titleOf } from "../lib/chats";
import { useIsMobile, useIsNarrowDesktop } from "../lib/useMediaQuery";
import { useMessenger } from "../shell/MessengerContext";
import { useThreadPreview } from "../conversation/useThreadPreview";
import { ThreadPanel } from "../conversation/ThreadPanel";
import { DirectoryDetailHead, DirectoryList, DirectoryRow, DirectorySplit } from "./DirectoryPage";
import { useChatMembers } from "./useChatMembers";

type Filter = "all" | "unread" | "mine";

function LoadingRows() {
  return (
    <>
      <SkeletonRow lines={["90%", "45%"]} />
      <SkeletonRow lines={["70%", "55%"]} />
      <SkeletonRow lines={["80%", "40%"]} />
    </>
  );
}

export function ThreadDirectory({ selectedID }: { selectedID?: string }) {
  const { t } = useTranslation();
  const { api, user, store, navigate } = useMessenger();
  const isMobile = useIsMobile();
  const narrow = useIsNarrowDesktop();
  const chats = useStore(store, (state) => state.chats);
  const unreadThreads = useStore(store, (state) => state.unread.threads);
  const [filter, setFilter] = useState<Filter>("all");
  const query = useQuery({ queryKey: ["threads"], queryFn: () => api.threads() });
  const threads: ThreadSummary[] = useMemo(() => query.data?.threads ?? [], [query.data]);

  const unreadCount = (id: string) =>
    unreadThreads.find((item) => item.thread_root_id === id)?.unread_count ?? 0;
  const unreadTotal = threads.filter((item) => unreadCount(item.root.id) > 0).length;
  const mineTotal = threads.filter((item) => item.root.actor_id === user.id).length;
  const visible = threads.filter((item) =>
    filter === "unread"
      ? unreadCount(item.root.id) > 0
      : filter === "mine"
        ? item.root.actor_id === user.id
        : true,
  );
  // Desktop keeps the workspace busy: the first thread is open unless the URL says otherwise.
  const activeID = selectedID ?? (!isMobile && !narrow ? visible[0]?.root.id : undefined);
  const active = threads.find((item) => item.root.id === activeID);

  const list = (
    <DirectoryList
      title={t("threads")}
      lead={t("threadsLead")}
      action={
        <IconButton
          size="icon-sm"
          label={t("refreshList")}
          className="directory-list__refresh"
          onClick={() => void query.refetch()}
        >
          <RefreshCw className={query.isFetching ? "ui-spin" : undefined} />
        </IconButton>
      }
      chips={
        query.data && (
          <>
            <Chip active={filter === "all"} onClick={() => setFilter("all")}>
              {t("threadsFilterAll", { count: threads.length })}
            </Chip>
            <Chip active={filter === "unread"} onClick={() => setFilter("unread")}>
              {t("threadsFilterUnread", { count: unreadTotal })}
            </Chip>
            <Chip active={filter === "mine"} onClick={() => setFilter("mine")}>
              {t("threadsFilterMine", { count: mineTotal })}
            </Chip>
          </>
        )
      }
    >
      {query.isLoading ? (
        <LoadingRows />
      ) : query.isError ? (
        <InlineError
          center
          title={t("threadsLoadFailed")}
          onRetry={() => void query.refetch()}
          retryLabel={t("retry")}
        />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={<MessagesSquare />}
          title={filter === "all" ? t("noThreads") : t("threadsFilterEmpty")}
          hint={filter === "all" ? t("threadsEmptyHint") : undefined}
        />
      ) : (
        visible.map((item) => (
          <ThreadRow
            key={item.root.id}
            item={item}
            unread={unreadCount(item.root.id)}
            selected={!isMobile && item.root.id === activeID}
            onOpen={() =>
              navigate(
                isMobile
                  ? `/chat/${item.root.chat_id}/thread/${item.root.id}`
                  : `/threads/${item.root.id}`,
              )
            }
          />
        ))
      )}
    </DirectoryList>
  );

  if (isMobile) return list;
  return (
    <DirectorySplit
      list={list}
      detailOpen={Boolean(selectedID)}
      detail={
        active ? (
          <ThreadDetail key={active.root.id} item={active} onBack={() => navigate("/threads")} />
        ) : (
          <EmptyState
            className="directory-detail__empty"
            icon={<MessagesSquare />}
            title={t("threadPickTitle")}
            hint={t("threadPickHint")}
          />
        )
      }
    />
  );
}

function ThreadRow({
  item,
  unread,
  selected,
  onOpen,
}: {
  item: ThreadSummary;
  unread: number;
  selected: boolean;
  onOpen(): void;
}) {
  const { t } = useTranslation();
  const { user, store } = useMessenger();
  const chat = useStore(store, (state) => state.chats[item.root.chat_id]);
  const { members } = useChatMembers(chat?.id);
  const preview = useThreadPreview(item.root, true);
  const chatName = titleOf(chat, [], user.id);
  const deleted = Boolean(item.root.deleted_at);
  const last = preview.lastReply;
  const when = last?.created_at ?? item.root.created_at;
  return (
    <DirectoryRow
      className="directory-row--thread"
      selected={selected}
      leading={
        <span className="directory-thread-avatar">
          <Avatar
            name={chatName}
            seed={chat?.avatar_seed ?? item.root.chat_id}
            actorID={chat?.direct_peer?.actor_id}
            avatarVersion={chat?.direct_peer?.avatar_version}
            size="md"
          />
          <span className="directory-thread-avatar__badge" aria-hidden="true">
            <MessagesSquare strokeWidth={2.6} />
          </span>
        </span>
      }
      top={
        <>
          <span className="truncate">{chatName}</span>
          <time dateTime={when}>{formatAge(when)}</time>
        </>
      }
      text={
        deleted ? (
          <em className="directory-row__deleted">{t("threadRootDeleted")}</em>
        ) : (
          messagePlainText(item.root.body)
        )
      }
      meta={
        <>
          <span className="truncate">
            {last ? lastReplyLine(last, members, user.id, t) : authorLine(item.root, members, user.id, t)}
          </span>
          <Badge tone={unread > 0 ? "primary" : "soft"}>{countLabel(item.reply_count)}</Badge>
        </>
      }
      onClick={onOpen}
    />
  );
}

function nameOf(actorID: string, members: ChatMember[], userID: string, t: (key: string) => string) {
  if (actorID === userID) return t("you");
  return members.find((member) => member.actor_id === actorID)?.display_name ?? t("participant");
}

function lastReplyLine(reply: Message, members: ChatMember[], userID: string, t: (key: string) => string) {
  return `${nameOf(reply.actor_id, members, userID, t)}: ${messagePlainText(reply.body)}`;
}

function authorLine(root: Message, members: ChatMember[], userID: string, t: (key: string) => string) {
  return nameOf(root.actor_id, members, userID, t);
}

function ThreadDetail({ item, onBack }: { item: ThreadSummary; onBack(): void }) {
  const { t } = useTranslation();
  const { user, store } = useMessenger();
  const chat = useStore(store, (state) => state.chats[item.root.chat_id]);
  const { members, query } = useChatMembers(chat?.id);
  if (!chat) {
    return (
      <EmptyState className="directory-detail__empty" title={t("threadChatUnavailable")} />
    );
  }
  if (query.isLoading) {
    return (
      <div className="directory-detail__loading">
        <DirectoryDetailHead
          leading={<Avatar name={titleOf(chat, [], user.id)} seed={chat.avatar_seed} size="md" />}
          title={t("threadIn", { chat: titleOf(chat, [], user.id) })}
        />
        <SkeletonRow avatar={36} lines={["40%", "100%"]} />
        <SkeletonRow avatar={32} lines={["35%", "85%"]} />
      </div>
    );
  }
  return (
    <ThreadPanel
      variant="page"
      chat={chat}
      chatName={titleOf(chat, members, user.id)}
      members={members}
      rootID={item.root.id}
      onClose={onBack}
    />
  );
}
