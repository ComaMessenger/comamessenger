import { ChevronRight, MessagesSquare } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { messagePlainText, type ThreadSummary } from "@comamessenger/core";
import {
  Avatar,
  Badge,
  EmptyState,
  InlineError,
  SkeletonRow,
  countLabel,
} from "../ui";
import { formatListTime } from "../lib/format";
import { titleOf } from "../lib/chats";
import { useMessenger } from "../shell/MessengerContext";
import { DirectoryPage, DirectoryRow } from "./DirectoryPage";

function LoadingRows() {
  return (
    <>
      <SkeletonRow lines={["90%", "45%"]} />
      <SkeletonRow lines={["70%", "55%"]} />
      <SkeletonRow lines={["80%", "40%"]} />
    </>
  );
}

export function ThreadDirectory() {
  const { t } = useTranslation();
  const { api, user, store, navigate } = useMessenger();
  const chats = useStore(store, (state) => state.chats);
  const unreadThreads = useStore(store, (state) => state.unread.threads);
  const query = useQuery({
    queryKey: ["threads"],
    queryFn: () => api.threads(),
  });
  const threads: ThreadSummary[] = query.data?.threads ?? [];

  return (
    <DirectoryPage
      title={t("threads")}
      lead={t("threadsLead")}
      onBack={() => navigate("/chats")}
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
      ) : threads.length === 0 ? (
        <EmptyState
          icon={<MessagesSquare />}
          title={t("noThreads")}
          hint={t("threadsEmptyHint")}
        />
      ) : (
        threads.map((item) => {
          const chat = chats[item.root.chat_id];
          const chatName = titleOf(chat, [], user.id);
          const unread = unreadThreads.find(
            (thread) => thread.thread_root_id === item.root.id,
          );
          const hasUnread = (unread?.unread_count ?? 0) > 0;
          const deleted = Boolean(item.root.deleted_at);
          const meta = [chatName, formatListTime(item.root.created_at)].join(
            " · ",
          );
          return (
            <DirectoryRow
              key={item.root.id}
              className="directory-row--thread"
              leading={
                <span className="directory-thread-avatar">
                  <Avatar
                    name={chatName}
                    seed={chat?.avatar_seed ?? item.root.chat_id}
                    actorID={chat?.direct_peer?.actor_id}
                    avatarVersion={chat?.direct_peer?.avatar_version}
                    size="lg"
                  />
                  <span className="directory-thread-avatar__badge" aria-hidden="true">
                    <MessagesSquare strokeWidth={2.6} />
                  </span>
                </span>
              }
              text={
                deleted ? (
                  <em className="directory-row__deleted">
                    {t("threadRootDeleted")}
                  </em>
                ) : (
                  messagePlainText(item.root.body)
                )
              }
              meta={meta}
              trailing={
                <>
                  <Badge size="lg" tone={hasUnread ? "primary" : "soft"}>
                    {countLabel(item.reply_count)}
                  </Badge>
                  <ChevronRight className="directory-row__chevron" aria-hidden="true" />
                </>
              }
              onClick={() =>
                navigate(`/chat/${item.root.chat_id}/thread/${item.root.id}`)
              }
            />
          );
        })
      )}
    </DirectoryPage>
  );
}
