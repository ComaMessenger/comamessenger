import { useEffect, useMemo, useState } from "react";
import { Download, FileText, Image as ImageIcon, Link2, Pin } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  messagePlainText,
  type ActorSummary,
  type Chat,
  type ChatMember,
  type SearchResult,
} from "@comamessenger/core";
import {
  Avatar,
  Button,
  Dialog,
  EmptyState,
  Field,
  InlineError,
  Segmented,
  Skeleton,
  SkeletonRow,
  Tabs,
  Tag,
  cx,
} from "../ui";
import { messageOf } from "../errors";
import { canManageChat, titleOf } from "../lib/chats";
import { formatListTime } from "../lib/format";
import { useMessenger } from "../shell/MessengerContext";
import { ActorPicker } from "./ActorPicker";
import { usePinnedMessages } from "./PinnedMessagesDialog";
import { downloadToDisk, useObjectURL } from "./useObjectURL";

type NotifyLevel = "all" | "mentions" | "none";
type AttachmentTab = "media" | "files" | "links" | "pinned";

const visibleMembers = 4;

export function ChatInfoDialog({
  chat,
  members,
  onClose,
  onOpenMessage,
}: {
  chat: Chat;
  members: ChatMember[];
  onClose(): void;
  onOpenMessage(messageID: string): void;
}) {
  const { t } = useTranslation();
  const { api, user, scheduleReload } = useMessenger();
  const manageable = canManageChat(chat);
  const title = titleOf(chat, members, user.id);
  const [name, setName] = useState(chat.name ?? chat.display_name);
  const [topic, setTopic] = useState(chat.topic);
  const [notifyLevel, setNotifyLevel] = useState<NotifyLevel>("all");
  const [tab, setTab] = useState<AttachmentTab>("media");
  const [allMembers, setAllMembers] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newMembers, setNewMembers] = useState<ActorSummary[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const notifications = useQuery({
    queryKey: ["chat-notifications", chat.id],
    queryFn: () => api.chatNotifications(chat.id),
  });
  useEffect(() => {
    if (!notifications.data) return;
    const level = notifications.data.notify_level;
    setNotifyLevel(level === "default" ? "all" : level);
  }, [notifications.data]);
  const attachments = useQuery({
    queryKey: ["chat-attachments", chat.id],
    queryFn: () => api.search({ q: "*", type: "file", chat_id: chat.id, limit: 60 }),
    retry: false,
  });
  const pinned = usePinnedMessages(chat.id);
  const files = attachments.data?.results ?? [];
  const media = useMemo(
    () => files.filter((item) => item.file_mime?.startsWith("image/") || item.file_mime?.startsWith("video/")),
    [files],
  );
  const documents = useMemo(
    () => files.filter((item) => !media.includes(item)),
    [files, media],
  );
  const memberRows = allMembers ? members : members.slice(0, visibleMembers);
  const nameOf = (actorID: string) =>
    members.find((member) => member.actor_id === actorID)?.display_name ?? t("participant");

  async function save() {
    setPending(true);
    setError("");
    try {
      await Promise.all([
        manageable && (name.trim() !== (chat.name ?? chat.display_name) || topic !== chat.topic)
          ? api.updateChat(chat.id, { name: name.trim(), topic })
          : Promise.resolve(),
        api.updateChatNotifications(chat.id, { notify_level: notifyLevel, muted_until: null }),
        ...newMembers.map((actor) => api.addMember(chat.id, actor.actor_id)),
      ]);
      scheduleReload();
      onClose();
    } catch (cause) {
      setError(messageOf(cause));
      setPending(false);
    }
  }

  const tabs: Array<{ id: AttachmentTab; label: string }> = [
    { id: "media", label: `${t("attachmentsMedia")} · ${media.length}` },
    { id: "files", label: `${t("attachmentsFiles")} · ${documents.length}` },
    { id: "links", label: `${t("attachmentsLinks")} · 0` },
    { id: "pinned", label: `${t("attachmentsPinned")} · ${pinned.data?.length ?? 0}` },
  ];

  return (
    <Dialog
      title={t("aboutChat")}
      onClose={onClose}
      className="chat-info"
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            {t("cancel")}
          </Button>
          <Button variant="primary" pending={pending} onClick={() => void save()}>
            {t("save")}
          </Button>
        </>
      }
    >
      <div className="chat-info__identity">
        <Avatar
          name={title}
          seed={chat.avatar_seed}
          actorID={chat.direct_peer?.actor_id}
          avatarVersion={chat.direct_peer?.avatar_version}
          agent={chat.direct_peer?.type === "agent"}
          size="xl"
        />
        {manageable ? (
          <div className="chat-info__fields">
            <Field
              label={t("title")}
              name="chat_name"
              compact
              className="chat-info__field"
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
            />
            <Field
              label={t("topic")}
              name="chat_topic"
              compact
              required={false}
              className="chat-info__field"
              value={topic}
              placeholder={t("chatTopicPlaceholder")}
              onChange={(event) => setTopic(event.target.value)}
            />
          </div>
        ) : (
          <div className="chat-info__readonly">
            <strong className="truncate">{title}</strong>
            {chat.topic && <small>{chat.topic}</small>}
            {chat.direct_peer?.title && !chat.topic && <small>{chat.direct_peer.title}</small>}
          </div>
        )}
      </div>

      <div className="chat-info__section">
        <span className="chat-info__label">{t("chatNotifications")}</span>
        <Segmented<NotifyLevel>
          label={t("notificationLevel")}
          value={notifyLevel}
          onChange={setNotifyLevel}
          items={[
            { id: "all", label: t("notifyAll") },
            { id: "mentions", label: t("notifyMentions") },
            { id: "none", label: t("notifyOff") },
          ]}
        />
      </div>

      <div className="chat-info__section">
        <Tabs<AttachmentTab> label={t("attachmentsFiles")} value={tab} onChange={setTab} items={tabs} className="chat-info__tabs" />
        {tab === "media" && (
          attachments.isLoading ? (
            <div className="chat-info__media-grid" aria-hidden="true">
              {Array.from({ length: 6 }, (_, index) => (
                <Skeleton key={index} shape="rect" className="chat-info__media-skeleton" />
              ))}
            </div>
          ) : attachments.isError ? (
            <InlineError title={t("attachmentsError")} onRetry={() => void attachments.refetch()} retryLabel={t("retry")} center />
          ) : media.length === 0 ? (
            <EmptyState compact icon={<ImageIcon />} title={t("mediaEmpty")} hint={t("mediaEmptyHint")} />
          ) : (
            <div className="chat-info__media-grid">
              {media.slice(0, 5).map((item) => (
                <MediaTile key={item.file_id} result={item} onOpen={() => onOpenMessage(item.message_id)} />
              ))}
              {media.length > 5 && (
                <button type="button" className="chat-info__media-more" onClick={() => onOpenMessage(media[5]!.message_id)}>
                  +{media.length - 5}
                </button>
              )}
            </div>
          )
        )}
        {tab === "files" && (
          attachments.isLoading ? (
            <>
              <SkeletonRow avatar={36} />
              <SkeletonRow avatar={36} />
            </>
          ) : attachments.isError ? (
            <InlineError title={t("attachmentsError")} onRetry={() => void attachments.refetch()} retryLabel={t("retry")} center />
          ) : documents.length === 0 ? (
            <EmptyState compact icon={<FileText />} title={t("filesEmpty")} hint={t("filesEmptyHint")} />
          ) : (
            <div className="chat-info__files">
              {documents.map((item) => (
                <div key={item.file_id} className="chat-info__file">
                  <button type="button" className="chat-info__file-main" onClick={() => onOpenMessage(item.message_id)}>
                    <span className="chat-info__file-icon" aria-hidden="true">
                      <FileText />
                    </span>
                    <span className="chat-info__file-copy">
                      <strong className="truncate">{item.file_name}</strong>
                      <small className="truncate">
                        {[item.file_mime?.split("/").pop()?.toUpperCase(), nameOf(item.actor_id), formatListTime(item.created_at)]
                          .filter(Boolean)
                          .join(" · ")}
                      </small>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="chat-info__download"
                    aria-label={t("download")}
                    onClick={() => void downloadToDisk(api, item.file_id!, item.file_name ?? "file")}
                  >
                    <Download aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          )
        )}
        {tab === "links" && (
          <EmptyState compact icon={<Link2 />} title={t("linksEmpty")} hint={t("linksEmptyHint")} />
        )}
        {tab === "pinned" && (
          pinned.isLoading ? (
            <>
              <SkeletonRow avatar={28} />
              <SkeletonRow avatar={28} />
            </>
          ) : pinned.isError ? (
            <InlineError title={t("pinnedLoadError")} onRetry={() => void pinned.refetch()} retryLabel={t("retry")} center />
          ) : !pinned.data?.length ? (
            <EmptyState compact icon={<Pin />} title={t("pinnedEmpty")} hint={t("pinnedEmptyHint")} />
          ) : (
            <div className="chat-info__pinned">
              {pinned.data.map(({ pin, message }) => (
                <button key={pin.message_id} type="button" className="chat-info__pin" onClick={() => onOpenMessage(pin.message_id)}>
                  <Avatar name={message ? nameOf(message.actor_id) : t("participant")} seed={message?.actor_id ?? pin.message_id} size="xs" />
                  <span className="chat-info__pin-copy">
                    <span className="chat-info__pin-head">
                      <strong className="truncate">{message ? nameOf(message.actor_id) : t("participant")}</strong>
                      <small>{formatListTime(message?.created_at ?? pin.pinned_at)}</small>
                    </span>
                    <span className="clamp-2">{message ? messagePlainText(message.body) : ""}</span>
                  </span>
                  <Pin className="chat-info__pin-icon" aria-hidden="true" />
                </button>
              ))}
              <p className="chat-info__hint">{t("pinnedUnpinHint")}</p>
            </div>
          )
        )}
      </div>

      {chat.kind !== "direct" && (
        <div className="chat-info__section">
          <div className="chat-info__label-row">
            <span className="chat-info__label">{t("membersCount", { count: members.length })}</span>
            {manageable && !adding && (
              <button type="button" className="chat-info__add" onClick={() => setAdding(true)}>
                {t("addMember")}
              </button>
            )}
          </div>
          {adding && (
            <ActorPicker
              label={t("addMembers")}
              placeholder={t("addMemberSearch")}
              selected={newMembers}
              exclude={members.map((member) => member.actor_id)}
              onChange={setNewMembers}
            />
          )}
          <div className="chat-info__members">
            {memberRows.map((member) => (
              <div key={member.actor_id} className="chat-info__member">
                <Avatar
                  name={member.display_name}
                  seed={member.actor_id}
                  actorID={member.actor_id}
                  avatarVersion={member.avatar_version}
                  square={member.type === "agent"}
                  size="sm"
                />
                <span className="truncate">{member.display_name}</span>
                {member.type === "agent" ? (
                  <Tag tone="agent">{t("agent")}</Tag>
                ) : member.role !== "member" ? (
                  <small className="chat-info__role">
                    {member.role === "owner" ? t("memberRoleOwner") : t("memberRoleAdmin")}
                  </small>
                ) : null}
              </div>
            ))}
            {members.length > visibleMembers && (
              <button type="button" className="chat-info__more" onClick={() => setAllMembers((value) => !value)}>
                {allMembers ? t("showFewer") : t("showMore", { count: members.length - visibleMembers })}
              </button>
            )}
          </div>
        </div>
      )}
      {error && <InlineError title={error} />}
    </Dialog>
  );
}

function MediaTile({ result, onOpen }: { result: SearchResult; onOpen(): void }) {
  const { api } = useMessenger();
  const preview = useObjectURL(api, result.file_id);
  const isVideo = result.file_mime?.startsWith("video/");
  return (
    <button type="button" className={cx("chat-info__media", isVideo && "chat-info__media--video")} onClick={onOpen} title={result.file_name}>
      {preview && !isVideo ? <img src={preview} alt="" /> : <ImageIcon aria-hidden="true" />}
      {isVideo && <span className="chat-info__play" aria-hidden="true" />}
      <span className="visually-hidden">{result.file_name ?? ""}</span>
    </button>
  );
}
