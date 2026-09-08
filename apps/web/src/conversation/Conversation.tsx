import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ChevronLeft, Info, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import type { Chat, Message } from "@comamessenger/core";
import { hasPermission } from "../settings";
import { Avatar, EmptyState, IconButton, InlineError, PresenceDot, cx } from "../ui";
import { getLocalDraft, setLocalDraft, syncDraft } from "../lib/drafts";
import { formatDaySeparator, minuteGap } from "../lib/format";
import { resolvedMentionActorIDs } from "../lib/mentions";
import { canManageChat, chatGlyph, isReadOnly, titleOf } from "../lib/chats";
import { useIsMobile } from "../lib/useMediaQuery";
import { useMessenger } from "../shell/MessengerContext";
import { Composer } from "../composer/Composer";
import { useAttachments } from "../composer/useAttachments";
import { ChatInfoDialog } from "../dialogs/ChatInfoDialog";
import { useMessageFeed } from "./useMessageFeed";
import { MessageRow } from "./MessageRow";
import { AgentStreamRow } from "./AgentStreamRow";
import { ChatIntro } from "./ChatIntro";
import { ThreadPanel } from "./ThreadPanel";

const emptyActorIDs: string[] = [];

export function Conversation({
  chatID,
  chat,
  threadID,
  onBack,
  onOpenThread,
  onCloseThread,
}: {
  chatID: string;
  chat?: Chat;
  threadID: string | null;
  onBack(): void;
  onOpenThread(id: string): void;
  onCloseThread(): void;
}) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const { api, user, store, coordinator, outbox, scheduleReload, openDialog, whenReady } =
    useMessenger();
  const queryClient = useQueryClient();
  const typing = useStore(store, (state) => state.typing[chatID] ?? emptyActorIDs);
  const presence = useStore(store, (state) => state.presence);
  const messageStreams = useStore(store, (state) => state.messageStreams);
  const agentStatuses = useStore(store, (state) => state.agentStatuses);
  const membersQuery = useQuery({
    queryKey: ["chat-members", chatID],
    queryFn: () => api.members(chatID),
  });
  const pinsQuery = useQuery({
    queryKey: ["pins", chatID],
    queryFn: () => api.pins(chatID),
    staleTime: 30_000,
  });
  const members = membersQuery.data ?? [];
  const pinnedIDs = useMemo(
    () => new Set((pinsQuery.data ?? []).map((pin) => pin.message_id)),
    [pinsQuery.data],
  );
  const scroller = useRef<HTMLDivElement>(null);
  const feed = useMessageFeed({ api, store, chatID, scroller, whenReady });
  const attachments = useAttachments(api);
  const [reply, setReply] = useState<Message | null>(null);
  const [body, setBody] = useState(() => getLocalDraft(chatID, null));
  const [info, setInfo] = useState(false);

  const title = titleOf(chat, members, user.id);
  const directPeer =
    chat?.kind === "direct"
      ? (chat.direct_peer ?? members.find((member) => member.actor_id !== user.id))
      : undefined;
  const readonly = chat ? isReadOnly(chat) : false;
  const canModerate = hasPermission(user, "chats.moderate") || (chat ? canManageChat(chat) : false);
  const visibleStreams = Object.values(messageStreams).filter(
    (item) => item.chatID === chatID && item.threadRootID === null,
  );
  const activeAgents = Object.values(agentStatuses).filter(
    (item) =>
      item.chatID === chatID &&
      item.threadRootID === null &&
      (item.state === "thinking" || item.state === "tool" || item.state === "streaming"),
  );

  useEffect(() => {
    const timer = setTimeout(() => {
      setLocalDraft(chatID, null, body);
      void syncDraft(api, chatID, null, body);
    }, 600);
    return () => clearTimeout(timer);
  }, [api, body, chatID]);

  async function send() {
    const content = body.trim();
    const uploaded = attachments.ready;
    if ((!content && uploaded.length === 0) || attachments.uploading || readonly) return;
    setBody("");
    setReply(null);
    setLocalDraft(chatID, null, "");
    coordinator.typing(chatID, false, null);
    const fileIDs = uploaded.map((item) => item.file!.id);
    attachments.reset();
    await outbox.enqueue(chatID, {
      client_msg_id: crypto.randomUUID(),
      body: content,
      body_format: "markdown",
      reply_to_id: reply?.id,
      mentioned_actor_ids: resolvedMentionActorIDs(content, members, presence),
      file_ids: fileIDs,
    });
  }

  const typingNames = typing
    .filter((id) => id !== user.id)
    .map((id) => members.find((member) => member.actor_id === id)?.display_name)
    .filter((name): name is string => Boolean(name));
  const subtitle = activeAgents.length ? (
    <span className="conversation-head__agent">
      <PresenceDot pulse />
      {activeAgents.length === 1
        ? t("agentWorking", {
            name:
              members.find((member) => member.actor_id === activeAgents[0]!.actorID)?.display_name ??
              t("agent"),
          })
        : t("agentsWorking", { count: activeAgents.length })}
    </span>
  ) : typing.length ? (
    typingNames.length === 1 ? t("typingOne", { name: typingNames[0] }) : t("typingMany", { count: typing.length })
  ) : directPeer ? (
    directPeer.status_text
      ? `${directPeer.status_emoji} ${directPeer.status_text}`.trim()
      : directPeer.title || `@${directPeer.handle}`
  ) : chat?.topic ? (
    chat.topic
  ) : (
    t("headerMembers", { count: members.length })
  );

  return (
    <div className={cx("conversation", threadID && "conversation--thread-open")}>
      <div className="conversation__main">
        <header className="conversation-head">
          {isMobile && (
            <IconButton size="icon-lg" className="conversation-head__back" label={t("back")} onClick={onBack}>
              <ChevronLeft />
            </IconButton>
          )}
          <Avatar
            name={title}
            seed={chat?.avatar_seed}
            actorID={directPeer?.actor_id}
            avatarVersion={directPeer?.avatar_version}
            agent={directPeer?.type === "agent"}
            glyph={chatGlyph(chat)}
            presence={directPeer && directPeer.type !== "agent" ? presence[directPeer.actor_id] : undefined}
            size="md"
          />
          <button type="button" className="conversation-head__title" onClick={() => setInfo(true)}>
            <h1 className="truncate">{title}</h1>
            <span className="truncate">{subtitle}</span>
          </button>
          {!isMobile && (
            <IconButton
              label={t("searchInChat")}
              onClick={() => openDialog({ kind: "search", request: { tab: "messages", chatID } })}
            >
              <Search />
            </IconButton>
          )}
          <IconButton size={isMobile ? "icon-lg" : "icon"} label={t("chatInfo")} onClick={() => setInfo(true)}>
            <Info />
          </IconButton>
        </header>

        <div
          className={cx("message-scroll", feed.feedReady && "message-scroll--ready")}
          ref={scroller}
          aria-live="polite"
          onScroll={(event) => feed.onScroll(event.currentTarget)}
        >
          <div className="message-feed">
            {feed.loadingPrevious && <span className="message-feed__loader" aria-hidden="true" />}
            {feed.loadError && (
              <InlineError title={t("historyLoadFailed")} retryLabel={t("retry")} onRetry={feed.retryInitial} />
            )}
            {!feed.hasMore && chat && !feed.loadError && (
              <ChatIntro chat={chat} title={title} onAddMembers={() => setInfo(true)} />
            )}
            {feed.feedReady && feed.visible.length === 0 && !feed.loadError && (
              <EmptyState compact title={t("noMessages")} />
            )}
            <div className="message-feed__virtual" style={{ height: feed.virtual.getTotalSize() }}>
              {feed.virtual.getVirtualItems().map((row) => {
                const message = feed.visible[row.index]!;
                const previous = feed.visible[row.index - 1];
                const newDay =
                  !previous ||
                  new Date(previous.created_at).toDateString() !==
                    new Date(message.created_at).toDateString();
                const firstUnread =
                  feed.unreadAnchor > 0 &&
                  message.created_seq > feed.unreadAnchor &&
                  (!previous || previous.created_seq <= feed.unreadAnchor);
                return (
                  <div
                    key={message.id}
                    ref={feed.virtual.measureElement}
                    data-index={row.index}
                    className="message-feed__row"
                    style={{ transform: `translateY(${row.start}px)` }}
                  >
                    {newDay && (
                      <div className="day-separator">
                        <span>{formatDaySeparator(message.created_at)}</span>
                      </div>
                    )}
                    {firstUnread && (
                      <div className="unread-separator">
                        <span>{t("newMessages")}</span>
                      </div>
                    )}
                    <MessageRow
                      message={message}
                      members={members}
                      replyMessage={
                        message.reply_to_id
                          ? feed.messages.find((item) => item.id === message.reply_to_id)
                          : undefined
                      }
                      author={members.find((item) => item.actor_id === message.actor_id)}
                      own={message.actor_id === user.id || !message.actor_id}
                      canModerate={canModerate}
                      grouped={
                        !newDay &&
                        !firstUnread &&
                        previous?.actor_id === message.actor_id &&
                        minuteGap(previous.created_at, message.created_at) < 5
                      }
                      chatName={title}
                      pinned={pinnedIDs.has(message.id)}
                      onReply={() => setReply(message)}
                      onJump={(id) => void feed.jump(id)}
                      onRetry={() => void outbox.flush()}
                      onThread={() => onOpenThread(message.thread_root_id ?? message.id)}
                      onPinnedChanged={() => {
                        void queryClient.invalidateQueries({ queryKey: ["pins", chatID] });
                        void queryClient.invalidateQueries({ queryKey: ["important"] });
                      }}
                      onChanged={(updated) => {
                        store.getState().apply({
                          op: "event",
                          seq: Math.max(store.getState().checkpoint + 1, updated.created_seq),
                          type: "message.updated",
                          occurred_at: updated.created_at,
                          actor_id: updated.actor_id,
                          chat_id: updated.chat_id,
                          subject_id: updated.id,
                          data: updated,
                        });
                        scheduleReload();
                      }}
                    />
                  </div>
                );
              })}
            </div>
            {visibleStreams.map((stream) => (
              <AgentStreamRow
                key={stream.streamID}
                body={stream.body}
                author={members.find((item) => item.actor_id === stream.actorID)}
                state={agentStatuses[stream.runID]?.state ?? "streaming"}
              />
            ))}
          </div>
        </div>

        {feed.showScrollDown && (
          <button type="button" className="scroll-latest" aria-label={t("scrollToBottom")} onClick={feed.scrollToBottom}>
            <ArrowDown aria-hidden="true" />
            {feed.newBelow > 0 && <span>{t("newBelow", { count: feed.newBelow })}</span>}
          </button>
        )}

        <Composer
          members={members}
          presence={presence}
          body={body}
          setBody={(next) => {
            setBody(next);
            coordinator.typing(chatID, Boolean(next), null);
          }}
          onBlur={() => void syncDraft(api, chatID, null, body)}
          onSend={() => void send()}
          reply={reply}
          replyAuthor={members.find((item) => item.actor_id === reply?.actor_id)?.display_name}
          onCancelReply={() => setReply(null)}
          readonly={readonly}
          attachments={attachments.attachments}
          onFiles={attachments.add}
          onCancelFile={attachments.cancel}
          onRetryFile={attachments.retry}
        />
      </div>

      {threadID && chat && (
        <ThreadPanel chat={chat} chatName={title} members={members} rootID={threadID} onClose={onCloseThread} />
      )}
      {info && chat && (
        <ChatInfoDialog
          chat={chat}
          members={members}
          onClose={() => setInfo(false)}
          onOpenMessage={(messageID) => {
            setInfo(false);
            void feed.jump(messageID);
          }}
        />
      )}
    </div>
  );
}
