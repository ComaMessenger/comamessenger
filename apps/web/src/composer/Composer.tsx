import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  AtSign,
  ChevronDown,
  Clock3,
  Code2,
  FileText,
  Image,
  Link2,
  Megaphone,
  Paperclip,
  SendHorizontal,
  Smile,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  decodeMentions,
  encodeMentions,
  insertMention,
  messagePlainText,
  updateMentionText,
  type ChatMember,
  type Message,
} from "@comamessenger/core";
import { Avatar, FloatingPopover, IconButton, Menu, MenuDivider, MenuItem, cx } from "../ui";
import { EmojiPickerPanel } from "../lib/emoji";
import type { PresenceMap } from "../lib/mentions";
import { attachmentLimit, type ComposerAttachment } from "./useAttachments";
import { AttachmentItem } from "./AttachmentItem";

const sendModeKey = "coma-send-on-enter";

export function Composer({
  members,
  presence = {},
  body,
  setBody,
  onBlur,
  onSend,
  reply,
  replyAuthor,
  onCancelReply,
  readonly,
  attachments = [],
  onFiles,
  onCancelFile,
  onRetryFile,
  placeholder,
  compact = false,
  autoFocus = false,
  banner,
}: {
  members: ChatMember[];
  presence?: PresenceMap;
  body: string;
  setBody(value: string): void;
  onBlur(): void;
  onSend(): void;
  reply: Message | null;
  replyAuthor?: string;
  onCancelReply(): void;
  readonly: boolean;
  attachments?: ComposerAttachment[];
  onFiles?(files: File[]): void;
  onCancelFile?(id: string): void;
  onRetryFile?(id: string): void;
  placeholder?: string;
  /** Thread composer: fewer tools, no send hint. */
  compact?: boolean;
  autoFocus?: boolean;
  banner?: ReactNode;
}) {
  const { t } = useTranslation();
  const input = useRef<HTMLTextAreaElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const sendMenuAnchor = useRef<HTMLDivElement>(null);
  const emojiAnchor = useRef<HTMLButtonElement>(null);
  const attachAnchor = useRef<HTMLButtonElement>(null);
  const mediaInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const markdownInput = useRef<HTMLInputElement>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const [formatOpen, setFormatOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [sendMenuOpen, setSendMenuOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const [sendOnEnter, setSendOnEnter] = useState(
    () => localStorage.getItem(sendModeKey) !== "false",
  );
  const draft = useMemo(() => decodeMentions(body), [body]);
  const canSend =
    (Boolean(body.trim()) || attachments.some((item) => item.status === "ready")) &&
    !attachments.some((item) => item.status === "uploading");

  useEffect(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = "auto";
    const styles = getComputedStyle(element);
    const lineHeight = Number.parseFloat(styles.lineHeight) || 20;
    const maxHeight = lineHeight * 8;
    const nextHeight = Math.min(element.scrollHeight, maxHeight);
    element.style.height = `${nextHeight}px`;
    element.style.overflowY = element.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [draft.text]);

  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);

  const mention = /@([\p{L}\p{N}_.-]*)$/u.exec(draft.text);
  const mentionQuery = mention?.[1]?.toLowerCase() ?? "";
  const suggestions = mention
    ? members
        .filter(
          (member) =>
            member.display_name.toLowerCase().includes(mentionQuery) ||
            member.handle.toLowerCase().includes(mentionQuery),
        )
        .slice(0, 6)
    : [];
  const showContextMentions =
    Boolean(mention) &&
    members.length > 1 &&
    ("all".startsWith(mentionQuery) || "here".startsWith(mentionQuery));
  const onlineCount = members.filter((member) => presence[member.actor_id] === "online").length;

  function setVisibleText(nextText: string, cursor: number) {
    setBody(encodeMentions(updateMentionText(draft, nextText)));
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(cursor, cursor);
    });
  }
  function keys(event: KeyboardEvent<HTMLTextAreaElement>) {
    const shouldSend = sendOnEnter ? !event.shiftKey : event.shiftKey;
    if (event.key === "Enter" && shouldSend && !event.nativeEvent.isComposing) {
      event.preventDefault();
      onSend();
    }
  }
  function wrap(prefix: string, suffix = prefix, fallback = t("formatText")) {
    const start = input.current?.selectionStart ?? draft.text.length;
    const end = input.current?.selectionEnd ?? start;
    const selected = draft.text.slice(start, end) || fallback;
    const replacement = `${prefix}${selected}${suffix}`;
    setVisibleText(
      draft.text.slice(0, start) + replacement + draft.text.slice(end),
      start + replacement.length,
    );
  }
  function prefixLines(prefix: string) {
    const start = input.current?.selectionStart ?? draft.text.length;
    const end = input.current?.selectionEnd ?? start;
    const lineStart = draft.text.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
    const selected = draft.text.slice(lineStart, end) || t("formatText");
    const replacement = selected
      .split("\n")
      .map((line, index) => (prefix === "ordered" ? `${index + 1}. ${line}` : `${prefix}${line}`))
      .join("\n");
    setVisibleText(
      draft.text.slice(0, lineStart) + replacement + draft.text.slice(end),
      lineStart + replacement.length,
    );
  }
  function insertEmoji(emoji: string) {
    const start = input.current?.selectionStart ?? draft.text.length;
    const end = input.current?.selectionEnd ?? start;
    setVisibleText(draft.text.slice(0, start) + emoji + draft.text.slice(end), start + emoji.length);
    setEmojiOpen(false);
  }
  function insertMember(member: ChatMember) {
    if (!mention) return;
    const next = insertMention(draft, mention.index, draft.text.length, member.actor_id, member.display_name);
    setBody(encodeMentions(next));
    const cursor =
      (next.mentions.find((item) => item.start === mention.index)?.end ?? mention.index) + 1;
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(cursor, cursor);
    });
  }
  function insertContextual(value: "all" | "here") {
    if (!mention) return;
    const replacement = `@${value} `;
    setVisibleText(draft.text.slice(0, mention.index) + replacement, mention.index + replacement.length);
  }
  function chooseSendMode(value: boolean) {
    setSendOnEnter(value);
    localStorage.setItem(sendModeKey, String(value));
    setSendMenuOpen(false);
  }
  function pickFiles(event: ChangeEvent<HTMLInputElement>) {
    onFiles?.([...(event.target.files ?? [])]);
    event.target.value = "";
    setAttachOpen(false);
  }

  if (readonly)
    return (
      <div className="composer-shell">
        <div className="composer-readonly">
          <Megaphone aria-hidden="true" />
          <span>{t("channelReadOnly")}</span>
        </div>
      </div>
    );

  const showMentionMenu = focused && Boolean(mention) && (suggestions.length > 0 || showContextMentions);

  return (
    <div
      className={cx("composer-shell", compact && "composer-shell--compact")}
      onDragOver={(event) => {
        if (!onFiles) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(event) => {
        if (!onFiles) return;
        event.preventDefault();
        onFiles([...event.dataTransfer.files]);
      }}
    >
      {banner}
      <div className={cx("composer", focused && "composer--focused")} ref={root}>
        {reply && (
          <div className="composer__reply">
            <span className="composer__reply-bar" aria-hidden="true" />
            <span className="composer__reply-copy">
              <strong>{t("replyingTo", { name: replyAuthor ?? t("participant") })}</strong>
              <span className="truncate">{messagePlainText(reply.body).slice(0, 160)}</span>
            </span>
            <IconButton size="icon-sm" label={t("cancel")} onClick={onCancelReply}>
              <X />
            </IconButton>
          </div>
        )}
        {attachments.length > 0 && (
          <div className="composer__attachments">
            {attachments.map((attachment) => (
              <AttachmentItem
                key={attachment.id}
                attachment={attachment}
                onCancel={() => onCancelFile?.(attachment.id)}
                onRetry={() => onRetryFile?.(attachment.id)}
              />
            ))}
          </div>
        )}
        {formatOpen && (
          <div className="composer__format" role="toolbar" aria-label={t("formatting")}>
            <button type="button" aria-label={t("bold")} onClick={() => wrap("**")}>
              <strong>B</strong>
            </button>
            <button type="button" aria-label={t("italic")} onClick={() => wrap("_")}>
              <em>I</em>
            </button>
            <button type="button" aria-label={t("underline")} onClick={() => wrap("++")}>
              <span className="composer__format-underline">U</span>
            </button>
            <button type="button" aria-label={t("strike")} onClick={() => wrap("~~")}>
              <s>S</s>
            </button>
            <span className="composer__format-divider" />
            <button type="button" aria-label={t("link")} onClick={() => wrap("[", "](https://)", t("linkText"))}>
              <Link2 aria-hidden="true" />
            </button>
            <span className="composer__format-divider" />
            <button type="button" aria-label={t("heading")} onClick={() => prefixLines("## ")}>
              H
            </button>
            <button type="button" aria-label={t("orderedList")} onClick={() => prefixLines("ordered")}>
              1.
            </button>
            <button type="button" aria-label={t("bulletList")} onClick={() => prefixLines("- ")}>
              •
            </button>
          </div>
        )}
        <textarea
          ref={input}
          className="composer__input"
          rows={1}
          value={draft.text}
          onChange={(event) => setBody(encodeMentions(updateMentionText(draft, event.target.value)))}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            onBlur();
            requestAnimationFrame(() => {
              if (!root.current?.contains(document.activeElement)) setFocused(false);
            });
          }}
          onKeyDown={keys}
          placeholder={placeholder ?? t("messagePlaceholder")}
          aria-label={placeholder ?? t("messagePlaceholder")}
        />
        <div className="composer__toolbar">
          <div className="composer__tools">
            <IconButton
              ref={attachAnchor}
              size="icon-sm"
              label={t("attach")}
              disabled={!onFiles || attachments.length >= attachmentLimit}
              aria-expanded={attachOpen}
              onClick={() => {
                setAttachOpen((open) => !open);
                setEmojiOpen(false);
                setSendMenuOpen(false);
              }}
            >
              <Paperclip />
            </IconButton>
            <input ref={mediaInput} hidden type="file" accept="image/*,video/*" multiple onChange={pickFiles} />
            <input ref={fileInput} hidden type="file" multiple onChange={pickFiles} />
            <input ref={markdownInput} hidden type="file" accept=".md,text/markdown,text/plain" multiple onChange={pickFiles} />
            {attachments.length > 0 && (
              <span className="composer__counter">
                {t("attachmentsCount", { count: attachments.length, limit: attachmentLimit })}
              </span>
            )}
            <IconButton
              ref={emojiAnchor}
              size="icon-sm"
              label={t("emoji")}
              aria-expanded={emojiOpen}
              onClick={() => {
                setEmojiOpen((open) => !open);
                setAttachOpen(false);
                setSendMenuOpen(false);
              }}
            >
              <Smile />
            </IconButton>
            {!compact && (
              <IconButton
                size="icon-sm"
                label={t("mention")}
                onClick={() => {
                  const text = draft.text;
                  const separator = text && !/\s$/.test(text) ? " " : "";
                  setVisibleText(`${text}${separator}@`, text.length + separator.length + 1);
                }}
              >
                <AtSign />
              </IconButton>
            )}
            <button
              type="button"
              className={cx("composer__aa", formatOpen && "composer__aa--active")}
              aria-label={t("formatting")}
              aria-pressed={formatOpen}
              onClick={() => setFormatOpen((open) => !open)}
            >
              {t("formatButton")}
            </button>
          </div>
          <div className="composer__send-area">
            {!compact && (
              <span className="composer__hint">
                {sendOnEnter ? t("composerEnterHint") : t("composerShiftEnterHint")}
              </span>
            )}
            <div
              ref={sendMenuAnchor}
              className={cx("composer__send", canSend && "composer__send--active")}
            >
              <button
                type="button"
                className="composer__send-main"
                aria-label={t("send")}
                disabled={!canSend}
                onClick={onSend}
              >
                <SendHorizontal aria-hidden="true" />
              </button>
              <button
                type="button"
                className="composer__send-more"
                aria-label={t("sendSettings")}
                aria-expanded={sendMenuOpen}
                onClick={() => {
                  setSendMenuOpen((open) => !open);
                  setEmojiOpen(false);
                  setAttachOpen(false);
                }}
              >
                <ChevronDown aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {attachOpen && (
        <FloatingPopover anchorRef={attachAnchor} placement="top-start" width={220} onDismiss={() => setAttachOpen(false)}>
          <Menu label={t("attach")}>
            <MenuItem icon={<Image />} onClick={() => mediaInput.current?.click()}>
              {t("attachMedia")}
            </MenuItem>
            <MenuItem icon={<FileText />} onClick={() => fileInput.current?.click()}>
              {t("attachFile")}
            </MenuItem>
            <MenuItem icon={<Code2 />} onClick={() => markdownInput.current?.click()}>
              {t("attachMarkdown")}
            </MenuItem>
          </Menu>
        </FloatingPopover>
      )}
      {emojiOpen && (
        <FloatingPopover anchorRef={emojiAnchor} placement="top-start" width={340} className="composer__emoji" onDismiss={() => setEmojiOpen(false)}>
          <div role="dialog" aria-label={t("emoji")}>
            <EmojiPickerPanel height={360} onPick={insertEmoji} />
          </div>
        </FloatingPopover>
      )}
      {sendMenuOpen && (
        <FloatingPopover anchorRef={sendMenuAnchor} placement="top-start" width={220} onDismiss={() => setSendMenuOpen(false)}>
          <Menu label={t("sendSettings")}>
            <MenuItem checked={sendOnEnter} onClick={() => chooseSendMode(true)}>
              {t("composerEnterHint")}
            </MenuItem>
            <MenuItem checked={!sendOnEnter} onClick={() => chooseSendMode(false)}>
              {t("composerShiftEnterHint")}
            </MenuItem>
            <MenuDivider />
            <MenuItem icon={<Clock3 />} disabled meta={t("comingLater")}>
              {t("sendLater")}
            </MenuItem>
          </Menu>
        </FloatingPopover>
      )}
      {showMentionMenu && (
        <FloatingPopover anchorRef={root} placement="top-start" width={250} onDismiss={() => undefined}>
          <Menu label={t("participants")} className="mention-menu">
            {suggestions.map((member) => (
              <button
                type="button"
                key={member.actor_id}
                role="menuitem"
                className="mention-menu__item"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => insertMember(member)}
              >
                <Avatar
                  name={member.display_name}
                  seed={member.actor_id}
                  actorID={member.actor_id}
                  avatarVersion={member.avatar_version}
                  agent={member.type === "agent"}
                  size="xs"
                />
                <strong className="truncate">{member.display_name}</strong>
                <span className="mention-menu__meta">@{member.handle}</span>
              </button>
            ))}
            {showContextMentions && suggestions.length > 0 && <MenuDivider />}
            {showContextMentions && (
              <>
                <button type="button" role="menuitem" className="mention-menu__item" onMouseDown={(event) => event.preventDefault()} onClick={() => insertContextual("all")}>
                  <span className="mention-menu__at">@</span>
                  <strong>{t("mentionAll")}</strong>
                  <span className="mention-menu__meta">{t("mentionAllMeta", { count: members.length })}</span>
                </button>
                <button type="button" role="menuitem" className="mention-menu__item" onMouseDown={(event) => event.preventDefault()} onClick={() => insertContextual("here")}>
                  <span className="mention-menu__at">@</span>
                  <strong>{t("mentionHere")}</strong>
                  <span className="mention-menu__meta">{t("mentionHereMeta", { count: onlineCount })}</span>
                </button>
              </>
            )}
          </Menu>
        </FloatingPopover>
      )}
    </div>
  );
}
