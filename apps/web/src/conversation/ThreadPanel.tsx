import { Fragment, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Check, ChevronLeft, ExternalLink, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import type { Chat, ChatMember, ClientMessage, Message } from "@comamessenger/core";
import { hasPermission } from "../settings";
import { Avatar, Chip, EmptyState, IconButton, InlineError, SkeletonRow, cx } from "../ui";
import { getLocalDraft, setLocalDraft, syncDraft } from "../lib/drafts";
import { formatAgePhrase, minuteGap } from "../lib/format";
import { resolvedMentionActorIDs } from "../lib/mentions";
import { canManageChat, isReadOnly } from "../lib/chats";
import { useIsMobile } from "../lib/useMediaQuery";
import { useMessenger } from "../shell/MessengerContext";
import { Composer } from "../composer/Composer";
import { MessageRow } from "./MessageRow";
import { AgentStreamRow } from "./AgentStreamRow";

const emptyMessages: ClientMessage[] = [];

export function ThreadPanel({
  chat,
  chatName,
  members,
  rootID,
  onClose,
  variant = "panel",
}: {
  chat: Chat;
  chatName: string;
  members: ChatMember[];
  rootID: string;
  onClose(): void;
  /** "page" — the /threads detail pane: chat-centric header, ink root card, unread separator. */
  variant?: "panel" | "page";
}) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const { api, user, store, coordinator, outbox, navigate } = useMessenger();
  const isPage = variant === "page";
  const unreadThread = useStore(store, (state) =>
    state.unread.threads.find((item) => item.thread_root_id === rootID),
  );
  const queryClient = useQueryClient();
  const storedMessages = useStore(store, (state) => state.messages[chat.id] ?? emptyMessages);
  const presence = useStore(store, (state) => state.presence);
  const streams = useStore(store, (state) => state.messageStreams);
  const agentStatuses = useStore(store, (state) => state.agentStatuses);
  const query = useQuery({ queryKey: ["thread", rootID], queryFn: () => api.thread(rootID) });
  const followed = useQuery({ queryKey: ["threads"], queryFn: () => api.threads() });
  const [followOverride, setFollowOverride] = useState<boolean | null>(null);
  const [body, setBody] = useState(() => getLocalDraft(chat.id, rootID));
  const [reply, setReply] = useState<Message | null>(null);

  const following =
    followOverride ??
    Boolean(followed.data?.threads.some((item) => item.root.id === rootID));
  const messages = useMemo(() => {
    const values = [
      ...(query.data?.messages ?? []),
      ...storedMessages.filter((message) => message.id === rootID || message.thread_root_id === rootID),
    ];
    return [...new Map(values.map((message) => [message.id, message])).values()].sort(
      (left, right) => left.created_seq - right.created_seq,
    );
  }, [query.data?.messages, rootID, storedMessages]);
  const root = messages.find((message) => message.id === rootID);
  const replies = messages.filter((message) => message.thread_root_id === rootID);
  const participantCount = new Set(replies.map((message) => message.actor_id)).size;
  const lastReply = replies[replies.length - 1];
  // Replies past the reader's marker — the "new" separator goes before the first of them.
  const firstUnreadID =
    isPage && unreadThread && unreadThread.unread_count > 0
      ? replies.find((message) => message.created_seq > unreadThread.last_read_seq)?.id
      : undefined;
  const canModerate = hasPermission(user, "chats.moderate") || canManageChat(chat);

  useEffect(() => {
    const timer = setTimeout(() => {
      setLocalDraft(chat.id, rootID, body);
      void syncDraft(api, chat.id, rootID, body);
    }, 600);
    return () => clearTimeout(timer);
  }, [api, body, chat.id, rootID]);

  async function toggleFollow() {
    const next = !following;
    setFollowOverride(next);
    try {
      if (next) await api.followThread(rootID);
      else await api.unfollowThread(rootID);
      await queryClient.invalidateQueries({ queryKey: ["threads"] });
    } catch {
      setFollowOverride(!next);
    }
  }
  async function send() {
    const content = body.trim();
    if (!content) return;
    setBody("");
    setReply(null);
    setLocalDraft(chat.id, rootID, "");
    coordinator.typing(chat.id, false, rootID);
    await outbox.enqueue(chat.id, {
      client_msg_id: crypto.randomUUID(),
      body: content,
      body_format: "markdown",
      reply_to_id: reply?.id,
      thread_root_id: rootID,
      mentioned_actor_ids: resolvedMentionActorIDs(content, members, presence),
    });
  }
  const refresh = () => void query.refetch();

  return (
    <aside className={cx("thread-panel", isPage && "thread-panel--page")} aria-label={t("threadTitle")}>
      <header className={cx("thread-panel__head", isPage && "thread-panel__head--page")}>
        {isMobile && (
          <IconButton size="icon-lg" label={t("back")} onClick={onClose}>
            <ChevronLeft />
          </IconButton>
        )}
        {isPage && (
          <Avatar
            name={chatName}
            seed={chat.avatar_seed}
            actorID={chat.direct_peer?.actor_id}
            avatarVersion={chat.direct_peer?.avatar_version}
            size="md"
          />
        )}
        <div className="thread-panel__title">
          <strong className="truncate">{isPage ? t("threadIn", { chat: chatName }) : t("threadTitle")}</strong>
          <span className="truncate">
            {isPage
              ? [
                  t("threadReplies", { count: replies.length }),
                  t("threadParticipants", { count: participantCount }),
                  lastReply && t("threadLastAgo", { age: formatAgePhrase(lastReply.created_at) }),
                ]
                  .filter(Boolean)
                  .join(" · ")
              : t("threadMeta", { replies: t("threadReplies", { count: replies.length }), chat: chatName })}
          </span>
        </div>
        <Chip
          size={isMobile ? "xl" : "lg"}
          className={cx("thread-panel__follow", following && "thread-panel__follow--on")}
          aria-pressed={following}
          onClick={() => void toggleFollow()}
        >
          {following && <Check strokeWidth={2.4} />}
          {following ? t("threadSubscribed") : t("threadSubscribe")}
        </Chip>
        {isPage && !isMobile && (
          <Chip size="lg" onClick={() => navigate(`/chat/${chat.id}/thread/${rootID}`)}>
            {t("threadOpenInChat")}
            <ExternalLink aria-hidden="true" />
          </Chip>
        )}
        {!isMobile && !isPage && (
          <IconButton size="icon-sm" label={t("close")} onClick={onClose}>
            <X />
          </IconButton>
        )}
      </header>
      <div className="thread-panel__scroll">
        {query.isLoading && !root ? (
          <div className="thread-panel__skeleton">
            <SkeletonRow avatar={36} lines={["40%", "100%"]} />
            <SkeletonRow avatar={32} lines={["35%", "85%"]} />
          </div>
        ) : query.isError && !root ? (
          <InlineError title={t("threadLoadFailed")} retryLabel={t("retry")} onRetry={refresh} />
        ) : (
          <>
            {root && root.deleted_at ? (
              <div className="thread-panel__root thread-panel__root--deleted">
                <span className="thread-panel__deleted-avatar" aria-hidden="true" />
                <div>
                  <strong>{t("threadRootDeleted")}</strong>
                  <small>{t("threadRootDeletedHint")}</small>
                </div>
              </div>
            ) : root ? (
              <div className={cx("thread-panel__root", isPage && "thread-panel__root--ink")}>
                <MessageRow
                  message={root}
                  members={members}
                  author={members.find((item) => item.actor_id === root.actor_id)}
                  own={root.actor_id === user.id}
                  canModerate={canModerate}
                  grouped={false}
                  chatName={chatName}
                  onReply={() => setReply(root)}
                  onJump={() => undefined}
                  onRetry={() => void outbox.flush()}
                  onThread={() => undefined}
                  onChanged={refresh}
                  domIDPrefix="thread-message"
                  showThreadIndicator={false}
                />
                {isPage && (
                  <button
                    type="button"
                    className="thread-panel__jump"
                    onClick={() => navigate(`/chat/${chat.id}?message=${rootID}`)}
                  >
                    {t("threadJumpToMessage")}
                    <ArrowUpRight aria-hidden="true" />
                  </button>
                )}
              </div>
            ) : null}
            {replies.length > 0 ? (
              <div className="thread-panel__separator">
                <span>{t("threadReplies", { count: replies.length })}</span>
                <i aria-hidden="true" />
              </div>
            ) : (
              query.isSuccess && (
                <EmptyState compact title={t("threadEmptyTitle")} hint={t("threadEmptyHint")} />
              )
            )}
            {replies.map((message, index) => {
              const previous = replies[index - 1];
              const row = (
                <MessageRow
                  key={message.id}
                  message={message}
                  members={members}
                  replyMessage={messages.find((item) => item.id === message.reply_to_id)}
                  author={members.find((item) => item.actor_id === message.actor_id)}
                  own={message.actor_id === user.id}
                  canModerate={canModerate}
                  grouped={
                    previous?.actor_id === message.actor_id &&
                    minuteGap(previous.created_at, message.created_at) < 5
                  }
                  chatName={chatName}
                  compact
                  onReply={() => setReply(message)}
                  onJump={(id) =>
                    document.getElementById(`thread-message-${id}`)?.scrollIntoView({ block: "center" })
                  }
                  onRetry={() => void outbox.flush()}
                  onThread={() => undefined}
                  onChanged={refresh}
                  domIDPrefix="thread-message"
                  showThreadIndicator={false}
                />
              );
              if (message.id !== firstUnreadID) return row;
              return (
                <Fragment key={message.id}>
                  <div className="thread-panel__separator thread-panel__separator--unread">
                    <span>{t("threadNew")}</span>
                    <i aria-hidden="true" />
                  </div>
                  {row}
                </Fragment>
              );
            })}
            {Object.values(streams)
              .filter((stream) => stream.chatID === chat.id && stream.threadRootID === rootID)
              .map((stream) => (
                <AgentStreamRow
                  key={stream.streamID}
                  body={stream.body}
                  author={members.find((member) => member.actor_id === stream.actorID)}
                  state={agentStatuses[stream.runID]?.state ?? "streaming"}
                />
              ))}
          </>
        )}
      </div>
      <Composer
        compact
        members={members}
        presence={presence}
        body={body}
        setBody={(next) => {
          setBody(next);
          coordinator.typing(chat.id, Boolean(next), rootID);
        }}
        onBlur={() => void syncDraft(api, chat.id, rootID, body)}
        onSend={() => void send()}
        reply={reply}
        replyAuthor={members.find((item) => item.actor_id === reply?.actor_id)?.display_name}
        onCancelReply={() => setReply(null)}
        readonly={isReadOnly(chat)}
        placeholder={t("threadReplyPlaceholder")}
      />
    </aside>
  );
}
