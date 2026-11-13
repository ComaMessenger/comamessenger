import { useEffect, useState } from "react";
import { Pin } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  chatAvatarSource,
  messagePlainText,
  type ActorSummary,
  type Chat,
  type ChatMember,
} from "@comamessenger/core";
import {
  Avatar,
  Button,
  Dialog,
  EmptyState,
  Field,
  InlineError,
  Segmented,
  SkeletonRow,
  Tabs,
  Tag,
} from "../ui";
import { messageOf } from "../errors";
import { canManageChat, titleOf } from "../lib/chats";
import { formatListTime } from "../lib/format";
import { useMessenger } from "../shell/MessengerContext";
import { ActorPicker } from "./ActorPicker";
import { usePinnedMessages } from "./PinnedMessagesDialog";
import { SharedFilesTab, SharedLinksTab, SharedMediaTab, SharedVoiceTab, useSharedCounts } from "./ChatSharedMedia";
import { ChatAgentsSection } from "../agentchat/ChatAgentsSection";

type NotifyLevel = "all" | "mentions" | "none";
type AttachmentTab = "media" | "files" | "voice" | "links" | "pinned";

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
  const { api, user, scheduleReload, navigate } = useMessenger();
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
  // The dialog keeps the chat it opened with; the new version shows at once
  // while the realtime chat.updated event refreshes the list behind it.
  const [avatarVersion, setAvatarVersion] = useState<number | null>(null);
  const [avatarPending, setAvatarPending] = useState(false);
  const [avatarError, setAvatarError] = useState("");
  const avatarSource = chatAvatarSource(chat);
  if (avatarVersion !== null && avatarSource.chatID) avatarSource.avatarVersion = avatarVersion;
  const notifications = useQuery({
    queryKey: ["chat-notifications", chat.id],
    queryFn: () => api.chatNotifications(chat.id),
  });
  useEffect(() => {
    if (!notifications.data) return;
    const level = notifications.data.notify_level;
    setNotifyLevel(level === "default" ? "all" : level);
  }, [notifications.data]);
  const counts = useSharedCounts(chat.id);
  const pinned = usePinnedMessages(chat.id);
  const memberRows = allMembers ? members : members.slice(0, visibleMembers);
  const nameOf = (actorID: string) =>
    members.find((member) => member.actor_id === actorID)?.display_name ?? t("participant");

  async function changeAvatar(file: File | null) {
    setAvatarError("");
    if (file && (file.size > 10_000_000 || !["image/png", "image/jpeg"].includes(file.type))) {
      setAvatarError(t("chatAvatarValidation"));
      return;
    }
    setAvatarPending(true);
    try {
      const updated = file ? await api.putChatAvatar(chat.id, file) : await api.deleteChatAvatar(chat.id);
      setAvatarVersion(updated.avatar_version);
      scheduleReload();
    } catch (cause) {
      setAvatarError(messageOf(cause));
    } finally {
      setAvatarPending(false);
    }
  }

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

  const count = (value: number | undefined) => (value === undefined ? "" : ` · ${value}`);
  const tabs: Array<{ id: AttachmentTab; label: string }> = [
    { id: "media", label: `${t("attachmentsMedia")}${count(counts.data?.media)}` },
    { id: "files", label: `${t("attachmentsFiles")}${count(counts.data?.files)}` },
    { id: "voice", label: `${t("attachmentsVoice")}${count(counts.data?.voice)}` },
    { id: "links", label: `${t("attachmentsLinks")}${count(counts.data?.links)}` },
    { id: "pinned", label: `${t("attachmentsPinned")}${count(pinned.data?.length)}` },
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
        {manageable ? (
          <div className="chat-info__avatar">
            <Avatar name={title} seed={chat.avatar_seed} {...avatarSource} size="xl" />
            <label className="ui-button ui-button--ghost ui-button--sm">
              {t("chatAvatarChange")}
              <input
                hidden
                type="file"
                accept="image/png,image/jpeg"
                disabled={avatarPending}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void changeAvatar(file);
                  event.target.value = "";
                }}
              />
            </label>
            {avatarSource.avatarVersion > 0 && (
              <Button size="sm" variant="ghost" disabled={avatarPending} onClick={() => void changeAvatar(null)}>
                {t("chatAvatarRemove")}
              </Button>
            )}
            {avatarError && (
              <small className="chat-info__avatar-error" role="alert">
                {avatarError}
              </small>
            )}
          </div>
        ) : (
          <Avatar
            name={title}
            seed={chat.avatar_seed}
            {...avatarSource}
            agent={chat.direct_peer?.type === "agent"}
            size="xl"
          />
        )}
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
        {tab === "media" && <SharedMediaTab chatID={chat.id} onOpenMessage={onOpenMessage} />}
        {tab === "files" && <SharedFilesTab chatID={chat.id} onOpenMessage={onOpenMessage} />}
        {tab === "voice" && <SharedVoiceTab chatID={chat.id} onOpenMessage={onOpenMessage} />}
        {tab === "links" && <SharedLinksTab chatID={chat.id} onOpenMessage={onOpenMessage} />}
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
        <ChatAgentsSection
          chatID={chat.id}
          members={members}
          onNavigate={(path) => {
            onClose();
            navigate(path);
          }}
        />
      )}

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
