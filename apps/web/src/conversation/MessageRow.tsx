import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  Clock3,
  Copy,
  CornerUpLeft,
  Eye,
  Forward,
  Link2,
  MessagesSquare,
  MoreHorizontal,
  Pencil,
  Pin,
  Plus,
  RefreshCw,
  SmilePlus,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  compactUUID,
  decodeMentions,
  encodeMentions,
  mentionedActorIDs,
  messagePlainText,
  updateMentionText,
  type ChatMember,
  type ClientMessage,
  type Message,
} from "@comamessenger/core";
import {
  Avatar,
  AvatarStack,
  FloatingPopover,
  IconButton,
  Menu,
  MenuDivider,
  MenuItem,
  Tag,
  cx,
} from "../ui";
import { Markdown } from "../markdown";
import { formatTime } from "../lib/format";
import { EmojiPickerPanel, quickReactions } from "../lib/emoji";
import { useMessenger } from "../shell/MessengerContext";
import { useToast } from "../shell/ToastProvider";
import { ConfirmDialog } from "../dialogs/ConfirmDialog";
import { ForwardMessageDialog } from "../dialogs/ForwardMessageDialog";
import { MessageDetailsDialog } from "../dialogs/MessageDetailsDialog";
import { MessageFile } from "./MessageFile";

export type MessageRowProps = {
  message: ClientMessage;
  members: ChatMember[];
  replyMessage?: ClientMessage;
  author?: ChatMember;
  own: boolean;
  canModerate: boolean;
  grouped: boolean;
  chatName: string;
  pinned?: boolean;
  onReply(): void;
  onJump(id: string): void;
  onRetry(): void;
  onThread(): void;
  onChanged(value: Message): void;
  onPinnedChanged?(): void;
  domIDPrefix?: string;
  showThreadIndicator?: boolean;
  compact?: boolean;
  threadParticipants?: ChatMember[];
};

export function MessageRow({
  message,
  members,
  replyMessage,
  author,
  own,
  canModerate,
  grouped,
  chatName,
  pinned = false,
  onReply,
  onJump,
  onRetry,
  onThread,
  onChanged,
  onPinnedChanged,
  domIDPrefix = "message",
  showThreadIndicator = true,
  compact = false,
  threadParticipants = [],
}: MessageRowProps) {
  const { t } = useTranslation();
  const { api, user } = useMessenger();
  const { toast } = useToast();
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [forwarding, setForwarding] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [busy, setBusy] = useState(false);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const mobileMenuRef = useRef<HTMLButtonElement>(null);
  const reactionsQuery = useQuery({
    queryKey: ["message-reactions", message.id],
    queryFn: () => api.reactions(message.id),
    staleTime: 15_000,
  });
  const replyQuery = useQuery({
    queryKey: ["message-context", message.reply_to_id],
    queryFn: () => api.messageContext(message.reply_to_id!),
    enabled: Boolean(message.reply_to_id && !replyMessage),
    staleTime: 5 * 60_000,
  });
  const resolvedReply =
    replyMessage ?? replyQuery.data?.messages.find((item) => item.id === message.reply_to_id);
  const replyAuthor = members.find((item) => item.actor_id === resolvedReply?.actor_id);
  const name = author?.display_name ?? (own ? t("you") : t("participant"));
  const isAgent = author?.type === "agent";
  const overlayOpen = menuOpen || pickerOpen;

  const reactionGroups = Object.entries(
    (reactionsQuery.data ?? []).reduce<Record<string, { count: number; own: boolean }>>(
      (groups, reaction) => {
        const current = groups[reaction.emoji] ?? { count: 0, own: false };
        groups[reaction.emoji] = {
          count: current.count + 1,
          own: current.own || reaction.actor_id === user.id,
        };
        return groups;
      },
      {},
    ),
  );

  function closeOverlays() {
    setMenuOpen(false);
    setPickerOpen(false);
  }
  async function toggleReaction(emoji: string) {
    closeOverlays();
    const ownReaction = (reactionsQuery.data ?? []).some(
      (reaction) => reaction.emoji === emoji && reaction.actor_id === user.id,
    );
    try {
      if (ownReaction) await api.unreact(message.id, emoji);
      else await api.react(message.id, emoji);
      await reactionsQuery.refetch();
    } catch {
      toast({ message: t("actionFailed"), tone: "danger" });
    }
  }
  async function togglePin() {
    closeOverlays();
    setBusy(true);
    try {
      if (pinned) {
        await api.unpin(message.id);
        toast({
          message: t("messageUnpinned"),
          action: { label: t("undo"), onClick: () => void api.pin(message.id).then(onPinnedChanged) },
        });
      } else {
        await api.pin(message.id);
        toast({
          message: t("messagePinned"),
          action: { label: t("undo"), onClick: () => void api.unpin(message.id).then(onPinnedChanged) },
        });
      }
      onPinnedChanged?.();
    } catch {
      toast({ message: t("actionFailed"), tone: "danger" });
    } finally {
      setBusy(false);
    }
  }
  async function copy(kind: "link" | "text") {
    closeOverlays();
    const value =
      kind === "link"
        ? `${location.origin}/m/${compactUUID(message.id)}`
        : messagePlainText(message.body);
    try {
      await navigator.clipboard.writeText(value);
      toast({ message: kind === "link" ? t("linkCopied") : t("textCopied") });
    } catch {
      toast({ message: t("actionFailed"), tone: "danger" });
    }
  }
  function startEdit() {
    closeOverlays();
    setEditText(decodeMentions(message.body).text);
    setEditing(true);
  }
  async function saveEdit() {
    const original = decodeMentions(message.body);
    if (!editText.trim() || editText === original.text) {
      setEditing(false);
      return;
    }
    setBusy(true);
    try {
      const body = encodeMentions(updateMentionText(original, editText));
      onChanged(
        await api.updateMessage(message.id, {
          body,
          body_format: "markdown",
          expected_version: message.version,
          mentioned_actor_ids: mentionedActorIDs(body),
        }),
      );
      setEditing(false);
    } catch {
      toast({ message: t("actionFailed"), tone: "danger" });
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    try {
      onChanged(await api.deleteMessage(message.id));
      setDeleting(false);
    } catch {
      toast({ message: t("actionFailed"), tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  const delivery = message.delivery;
  const failed = delivery === "failed";

  return (
    <article
      id={`${domIDPrefix}-${message.id}`}
      className={cx(
        "message",
        grouped && "message--grouped",
        compact && "message--compact",
        failed && "message--failed",
        isAgent && delivery === undefined && "message--agent",
        overlayOpen && "message--overlay-open",
        pinned && "message--pinned",
      )}
    >
      <div className="message__gutter">
        {!grouped && (
          <Avatar
            name={name}
            seed={message.actor_id}
            actorID={author?.actor_id}
            avatarVersion={author?.avatar_version}
            agent={isAgent}
            size={compact ? "sm" : "md"}
          />
        )}
        {grouped && (
          <time className="message__hover-time" dateTime={message.created_at}>
            {formatTime(message.created_at)}
          </time>
        )}
      </div>
      <div className="message__content">
        {!grouped && (
          <header className="message__meta">
            <strong>{name}</strong>
            {isAgent && <Tag tone="agent">{t("agentTag")}</Tag>}
            <time dateTime={message.created_at}>{formatTime(message.created_at)}</time>
            {message.edited_at && !message.deleted_at && (
              <span className="message__edited">{t("edited")}</span>
            )}
          </header>
        )}
        {message.forwarded_from && !message.deleted_at && (
          <span className="message__forwarded">
            <Forward aria-hidden="true" />
            {t("forwardedFrom", { name: message.forwarded_from.author_name })}
          </span>
        )}
        {message.reply_to_id && !message.deleted_at && (
          <button type="button" className="message__quote" onClick={() => onJump(message.reply_to_id!)}>
            <strong>{replyAuthor?.display_name ?? t("reply")}</strong>
            <span className="truncate">
              {resolvedReply ? messagePlainText(resolvedReply.body).slice(0, 160) : t("loading")}
            </span>
          </button>
        )}
        {editing ? (
          <div className="message__editor">
            <textarea
              value={editText}
              autoFocus
              rows={2}
              aria-label={t("editPrompt")}
              onChange={(event) => setEditText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setEditing(false);
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void saveEdit();
                }
              }}
            />
            <div className="message__editor-actions">
              <button type="button" className="ui-button ui-button--ghost ui-button--xs" onClick={() => setEditing(false)}>
                {t("cancel")}
              </button>
              <button type="button" className="ui-button ui-button--primary ui-button--xs" disabled={busy} onClick={() => void saveEdit()}>
                {t("save")}
              </button>
            </div>
          </div>
        ) : (
          <div className={cx("message__body", message.deleted_at && "message__body--deleted")}>
            {message.deleted_at ? (
              <em>{t("messageDeleted")}</em>
            ) : (
              <Markdown source={message.body} />
            )}
          </div>
        )}
        {!message.deleted_at && message.files.length > 0 && (
          <div className="message__files">
            {message.files.map((file) => (
              <MessageFile key={file.id} api={api} file={file} />
            ))}
          </div>
        )}
        {reactionGroups.length > 0 && !message.deleted_at && (
          <div className="message__reactions">
            {reactionGroups.map(([emoji, group]) => (
              <button
                type="button"
                key={emoji}
                className={cx("reaction-chip", group.own && "reaction-chip--own")}
                aria-pressed={group.own}
                onClick={() => void toggleReaction(emoji)}
              >
                <span>{emoji}</span>
                <span className="tabular">{group.count}</span>
              </button>
            ))}
            <button
              type="button"
              className="reaction-chip reaction-chip--add"
              aria-label={t("addReaction")}
              onClick={() => {
                setMenuOpen(false);
                setPickerOpen((open) => !open);
              }}
            >
              <Plus aria-hidden="true" />
            </button>
          </div>
        )}
        {showThreadIndicator && message.thread_reply_count > 0 && (
          <button type="button" className="message__thread" onClick={onThread}>
            {threadParticipants.length > 0 && (
              <AvatarStack>
                {threadParticipants.slice(0, 3).map((member) => (
                  <Avatar
                    key={member.actor_id}
                    name={member.display_name}
                    seed={member.actor_id}
                    actorID={member.actor_id}
                    avatarVersion={member.avatar_version}
                    size="xs"
                  />
                ))}
              </AvatarStack>
            )}
            {threadParticipants.length === 0 && <MessagesSquare aria-hidden="true" />}
            <strong>{t("threadReplies", { count: message.thread_reply_count })}</strong>
          </button>
        )}
        {delivery && delivery !== "sent" && (
          <span className={cx("message__delivery", failed && "message__delivery--failed")}>
            {delivery === "sending" ? (
              <>
                <Clock3 aria-hidden="true" />
                {t("deliverySending")}
              </>
            ) : delivery === "retrying" ? (
              <>
                <RefreshCw aria-hidden="true" />
                {t("retrying")}
              </>
            ) : (
              <>
                <AlertCircle aria-hidden="true" />
                {t("notSent")}
                <button type="button" className="message__retry" onClick={onRetry}>
                  {t("retry")}
                </button>
              </>
            )}
          </span>
        )}
      </div>

      {!message.deleted_at && !editing && (
        <div ref={toolbarRef} className="message__toolbar" aria-label={t("messageActions")}>
          <IconButton
            size="icon-sm"
            label={t("addReaction")}
            aria-expanded={pickerOpen}
            onClick={() => {
              setMenuOpen(false);
              setPickerOpen((open) => !open);
            }}
          >
            <SmilePlus />
          </IconButton>
          {showThreadIndicator && (
            <IconButton size="icon-sm" label={t("thread")} onClick={onThread}>
              <MessagesSquare />
            </IconButton>
          )}
          <IconButton
            ref={mobileMenuRef}
            size="icon-sm"
            label={t("openMenu")}
            aria-expanded={menuOpen}
            onClick={() => {
              setPickerOpen(false);
              setMenuOpen((open) => !open);
            }}
          >
            <MoreHorizontal />
          </IconButton>
        </div>
      )}

      {pickerOpen && (
        <FloatingPopover
          anchorRef={toolbarRef}
          placement="bottom-end"
          width={340}
          className="reaction-picker"
          onDismiss={() => setPickerOpen(false)}
        >
          <div role="dialog" aria-label={t("emoji")}>
            <div className="reaction-picker__quick">
              {quickReactions.map((emoji) => (
                <button type="button" key={emoji} onClick={() => void toggleReaction(emoji)}>
                  {emoji}
                </button>
              ))}
            </div>
            <EmojiPickerPanel height={320} onPick={(emoji) => void toggleReaction(emoji)} />
          </div>
        </FloatingPopover>
      )}
      {menuOpen && (
        <FloatingPopover
          anchorRef={toolbarRef}
          placement="bottom-end"
          width={228}
          onDismiss={() => setMenuOpen(false)}
        >
          <Menu label={t("messageActions")} className="message-menu">
            <div className="message-menu__quick">
              {quickReactions.map((emoji) => (
                <button type="button" key={emoji} aria-label={emoji} onClick={() => void toggleReaction(emoji)}>
                  {emoji}
                </button>
              ))}
              <button
                type="button"
                className="message-menu__quick-more"
                aria-label={t("addReaction")}
                onClick={() => {
                  setMenuOpen(false);
                  setPickerOpen(true);
                }}
              >
                <Plus aria-hidden="true" />
              </button>
            </div>
            <MenuItem icon={<CornerUpLeft />} onClick={() => { closeOverlays(); onReply(); }}>
              {t("reply")}
            </MenuItem>
            {showThreadIndicator && (
              <MenuItem icon={<MessagesSquare />} onClick={() => { closeOverlays(); onThread(); }}>
                {t("replyInThread")}
              </MenuItem>
            )}
            <MenuDivider />
            <MenuItem icon={<Pin />} disabled={busy} onClick={() => void togglePin()}>
              {pinned ? t("unpinMessage") : t("pinMessage")}
            </MenuItem>
            <MenuItem icon={<Forward />} onClick={() => { closeOverlays(); setForwarding(true); }}>
              {t("forwardMessage")}
            </MenuItem>
            <MenuItem icon={<Eye />} onClick={() => { closeOverlays(); setDetailsOpen(true); }}>
              {t("viewsAndReactions")}
            </MenuItem>
            <MenuDivider />
            <MenuItem icon={<Link2 />} onClick={() => void copy("link")}>
              {t("copyLink")}
            </MenuItem>
            <MenuItem icon={<Copy />} onClick={() => void copy("text")}>
              {t("copyText")}
            </MenuItem>
            {own && (
              <>
                <MenuDivider />
                <MenuItem icon={<Pencil />} onClick={startEdit}>
                  {t("editMessage")}
                </MenuItem>
              </>
            )}
            {(own || canModerate) && (
              <>
                <MenuDivider />
                <MenuItem danger icon={<Trash2 />} onClick={() => { closeOverlays(); setDeleting(true); }}>
                  {t("deleteMessage")}
                </MenuItem>
              </>
            )}
          </Menu>
        </FloatingPopover>
      )}
      {forwarding && (
        <ForwardMessageDialog
          message={message}
          authorName={name}
          chatName={chatName}
          onClose={() => setForwarding(false)}
        />
      )}
      {detailsOpen && (
        <MessageDetailsDialog message={message} members={members} onClose={() => setDetailsOpen(false)} />
      )}
      {deleting && (
        <ConfirmDialog
          danger
          title={t("deleteMessageTitle")}
          description={t("deleteMessageHint")}
          confirmLabel={t("deleteMessage")}
          pending={busy}
          icon={<Trash2 />}
          onConfirm={() => void remove()}
          onClose={() => setDeleting(false)}
        />
      )}
    </article>
  );
}
