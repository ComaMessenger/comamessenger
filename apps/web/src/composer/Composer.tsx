import {
  useEffect,
  useLayoutEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  AtSign,
  BellOff,
  ChevronDown,
  Clock3,
  BarChartHorizontal,
  Code2,
  FileText,
  Image,
  Link2,
  Megaphone,
  ListChecks,
  MessageSquareMore,
  Plus,
  SendHorizontal,
  Sparkles,
  Smile,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  composerMenu,
  commandQuery,
  decodeMentions,
  encodeMentions,
  matchCommands,
  insertMention,
  mentionSuggestions,
  messagePlainText,
  updateMentionText,
  type ChatCommand,
  type ChatMember,
  type ComposerMenuItemID,
  type DepartmentMentionSuggestion,
  type Message,
  type OrgStructure,
} from "@comamessenger/core";
import {
  Avatar,
  FloatingPopover,
  IconButton,
  Menu,
  MenuDivider,
  MenuItem,
  MenuLabel,
  cx,
} from "../ui";
import { DepartmentIcon } from "../org/DepartmentIcon";
import { EmojiPickerPanel } from "../lib/emoji";
import type { PresenceMap } from "../lib/mentions";
import { attachmentLimit, type ComposerAttachment } from "./useAttachments";
import { AttachmentItem } from "./AttachmentItem";
import { CommandMenu } from "../agentchat/CommandMenu";

const sendModeKey = "coma-send-on-enter";

const plusIcons: Record<ComposerMenuItemID, ReactNode> = {
  photo: <Image />,
  camera: <Image />,
  file: <FileText />,
  markdownFile: <Code2 />,
  request: <MessageSquareMore />,
  poll: <BarChartHorizontal />,
  task: <ListChecks />,
  agent: <Sparkles />,
};

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
  commands = [],
  onSchedule,
  onSendSilent,
  features,
  onRequest,
  structure = null,
  authorID = "",
  onTask,
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
  /** Agent commands offered after typing "/" at the start of a message. */
  commands?: ChatCommand[];
  /** "Send later…": opens the time picker for the current content. */
  onSchedule?(): void;
  /** "Send without sound". */
  onSendSilent?(): void;
  /** HelloFrame.features: Request in + needs `message_requests`. */
  features?: readonly string[];
  /** Request from +: opens the request form. */
  onRequest?(): void;
  /**
   * The org structure when the server announced org_structure: @ offers
   * departments that have someone of this chat besides the author.
   */
  structure?: OrgStructure | null;
  /** The author, left out of the department counts. */
  authorID?: string;
  /** Task from + (`message_tasks`): opens New task. */
  onTask?(): void;
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
  const [plusView, setPlusView] = useState<"menu" | "agents">("menu");
  const [formatOpen, setFormatOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [sendMenuOpen, setSendMenuOpen] = useState(false);
  // Phones have no arrow next to send: a long press opens the same menu.
  const longPress = useRef<{ timer: number; fired: boolean } | null>(null);
  const [focused, setFocused] = useState(false);
  const [sendOnEnter, setSendOnEnter] = useState(
    () => localStorage.getItem(sendModeKey) !== "false",
  );
  const draft = useMemo(() => decodeMentions(body), [body]);
  const commandMenuID = useId();
  const [commandIndex, setCommandIndex] = useState(0);
  const [commandsDismissed, setCommandsDismissed] = useState<string | null>(
    null,
  );
  const typedCommand = commands.length ? commandQuery(draft.text) : null;
  const commandMatches =
    typedCommand === null ? [] : matchCommands(commands, typedCommand);
  const showCommandMenu =
    focused && typedCommand !== null && commandsDismissed !== draft.text;
  const activeCommand = Math.min(
    commandIndex,
    Math.max(0, commandMatches.length - 1),
  );
  const canSend =
    (Boolean(body.trim()) ||
      attachments.some((item) => item.status === "ready")) &&
    !attachments.some((item) => item.status === "uploading");

  const agents = members.filter((member) => member.type === "agent");
  // Variant A of the prototype: attachments, Ask and assign, agents.
  // Scheduling stays on the send button's menu.
  const plusGroups = composerMenu({
    platform: "web",
    readonly,
    hasAgents: !compact && agents.length > 0,
    features: onRequest || onTask ? features : [],
    inThread: compact,
  })
    // A screen without the form does not offer its item.
    .map((group) => ({
      ...group,
      items: group.items.filter(
        (entry) =>
          (entry.id !== "task" || onTask) &&
          (entry.id !== "request" || onRequest),
      ),
    }))
    .filter((group) => group.items.length > 0);
  const atAttachmentLimit = attachments.length >= attachmentLimit;

  useEffect(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = "auto";
    const styles = getComputedStyle(element);
    const lineHeight = Number.parseFloat(styles.lineHeight) || 20;
    const maxHeight = lineHeight * 8;
    const nextHeight = Math.min(element.scrollHeight, maxHeight);
    element.style.height = `${nextHeight}px`;
    element.style.overflowY =
      element.scrollHeight > maxHeight ? "auto" : "hidden";
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
  const departmentSuggestions: DepartmentMentionSuggestion[] =
    mention && structure
      ? mentionSuggestions(mentionQuery, { members, authorID, structure })
          .departments
      : [];
  const showContextMentions =
    Boolean(mention) &&
    members.length > 1 &&
    ("all".startsWith(mentionQuery) || "here".startsWith(mentionQuery));
  const onlineCount = members.filter(
    (member) => presence[member.actor_id] === "online",
  ).length;

  // The caret goes where an insertion ends right after React writes the new
  // text, before the next key press: a frame later, a fast typist's first
  // letter would already have landed at the old caret position.
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const cursor = pendingCaret.current;
    if (cursor === null || !input.current) return;
    pendingCaret.current = null;
    input.current.focus();
    input.current.setSelectionRange(cursor, cursor);
  });
  function placeCaret(cursor: number) {
    pendingCaret.current = cursor;
    // The text may not change (nothing to re-render): apply it anyway.
    requestAnimationFrame(() => {
      if (pendingCaret.current !== cursor || !input.current) return;
      pendingCaret.current = null;
      input.current.focus();
      input.current.setSelectionRange(cursor, cursor);
    });
  }
  function setVisibleText(nextText: string, cursor: number) {
    setBody(encodeMentions(updateMentionText(draft, nextText)));
    placeCaret(cursor);
  }
  function insertCommand(command: ChatCommand) {
    const text = `/${command.command} `;
    setCommandIndex(0);
    setVisibleText(text, text.length);
  }
  function keys(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (showCommandMenu && !event.nativeEvent.isComposing) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setCommandsDismissed(draft.text);
        return;
      }
      if (commandMatches.length > 0) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const step = event.key === "ArrowDown" ? 1 : -1;
          setCommandIndex(
            (activeCommand + step + commandMatches.length) %
              commandMatches.length,
          );
          return;
        }
        if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
          event.preventDefault();
          insertCommand(commandMatches[activeCommand]!);
          return;
        }
      }
    }
    if (
      event.key === "Enter" &&
      (event.metaKey || event.ctrlKey) &&
      (event.shiftKey || event.altKey) &&
      !event.nativeEvent.isComposing
    ) {
      // ⌘/Ctrl+Shift+Enter: send later; ⌘/Ctrl+Alt+Enter: without sound.
      event.preventDefault();
      if (!canSend) return;
      if (event.shiftKey) onSchedule?.();
      else onSendSilent?.();
      return;
    }
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
      .map((line, index) =>
        prefix === "ordered" ? `${index + 1}. ${line}` : `${prefix}${line}`,
      )
      .join("\n");
    setVisibleText(
      draft.text.slice(0, lineStart) + replacement + draft.text.slice(end),
      lineStart + replacement.length,
    );
  }
  function insertEmoji(emoji: string) {
    const start = input.current?.selectionStart ?? draft.text.length;
    const end = input.current?.selectionEnd ?? start;
    setVisibleText(
      draft.text.slice(0, start) + emoji + draft.text.slice(end),
      start + emoji.length,
    );
    setEmojiOpen(false);
  }
  function insertMember(member: ChatMember) {
    if (!mention) return;
    const next = insertMention(
      draft,
      mention.index,
      draft.text.length,
      member.actor_id,
      member.display_name,
    );
    setBody(encodeMentions(next));
    const cursor =
      (next.mentions.find((item) => item.start === mention.index)?.end ??
        mention.index) + 1;
    placeCaret(cursor);
  }
  function insertDepartment(department: DepartmentMentionSuggestion) {
    if (!mention) return;
    const next = insertMention(
      draft,
      mention.index,
      draft.text.length,
      department.department.id,
      department.department.name,
    );
    setBody(encodeMentions(next));
    const cursor =
      (next.mentions.find((item) => item.start === mention.index)?.end ??
        mention.index) + 1;
    placeCaret(cursor);
  }
  function insertContextual(value: "all" | "here") {
    if (!mention) return;
    const replacement = `@${value} `;
    setVisibleText(
      draft.text.slice(0, mention.index) + replacement,
      mention.index + replacement.length,
    );
  }
  function callAgent(agent: ChatMember) {
    const separator = draft.text && !/\s$/.test(draft.text) ? " " : "";
    const base = { ...draft, text: draft.text + separator };
    const next = insertMention(
      base,
      base.text.length,
      base.text.length,
      agent.actor_id,
      agent.display_name,
    );
    setBody(encodeMentions(next));
    setAttachOpen(false);
    placeCaret(next.text.length);
  }
  function choosePlus(id: ComposerMenuItemID) {
    if (id === "photo") mediaInput.current?.click();
    else if (id === "file") fileInput.current?.click();
    else if (id === "markdownFile") markdownInput.current?.click();
    else if (id === "request") {
      setAttachOpen(false);
      onRequest?.();
    } else if (id === "task") {
      setAttachOpen(false);
      onTask?.();
    } else if (id === "agent") {
      if (agents.length === 1) callAgent(agents[0]!);
      else setPlusView("agents");
    }
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

  const showMentionMenu =
    focused &&
    Boolean(mention) &&
    (suggestions.length > 0 ||
      departmentSuggestions.length > 0 ||
      showContextMentions);

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
      <div
        className={cx("composer", focused && "composer--focused")}
        ref={root}
      >
        {reply && (
          <div className="composer__reply">
            <span className="composer__reply-bar" aria-hidden="true" />
            <span className="composer__reply-copy">
              <strong>
                {t("replyingTo", { name: replyAuthor ?? t("participant") })}
              </strong>
              <span className="truncate">
                {messagePlainText(reply.body).slice(0, 160)}
              </span>
            </span>
            <IconButton
              size="icon-sm"
              label={t("cancel")}
              onClick={onCancelReply}
            >
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
            <span className="composer__counter">
              {t("attachmentsCount", {
                count: attachments.length,
                limit: attachmentLimit,
              })}
            </span>
          </div>
        )}
        {formatOpen && (
          <div
            className="composer__format"
            role="toolbar"
            aria-label={t("formatting")}
          >
            <button
              type="button"
              aria-label={t("bold")}
              onClick={() => wrap("**")}
            >
              <strong>B</strong>
            </button>
            <button
              type="button"
              aria-label={t("italic")}
              onClick={() => wrap("_")}
            >
              <em>I</em>
            </button>
            <button
              type="button"
              aria-label={t("underline")}
              onClick={() => wrap("++")}
            >
              <span className="composer__format-underline">U</span>
            </button>
            <button
              type="button"
              aria-label={t("strike")}
              onClick={() => wrap("~~")}
            >
              <s>S</s>
            </button>
            <span className="composer__format-divider" />
            <button
              type="button"
              aria-label={t("link")}
              onClick={() => wrap("[", "](https://)", t("linkText"))}
            >
              <Link2 aria-hidden="true" />
            </button>
            <span className="composer__format-divider" />
            <button
              type="button"
              aria-label={t("heading")}
              onClick={() => prefixLines("## ")}
            >
              H
            </button>
            <button
              type="button"
              aria-label={t("orderedList")}
              onClick={() => prefixLines("ordered")}
            >
              1.
            </button>
            <button
              type="button"
              aria-label={t("bulletList")}
              onClick={() => prefixLines("- ")}
            >
              •
            </button>
          </div>
        )}
        <textarea
          ref={input}
          className="composer__input"
          rows={1}
          value={draft.text}
          onChange={(event) => {
            setCommandIndex(0);
            setBody(
              encodeMentions(updateMentionText(draft, event.target.value)),
            );
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            onBlur();
            requestAnimationFrame(() => {
              if (!root.current?.contains(document.activeElement))
                setFocused(false);
            });
          }}
          onKeyDown={keys}
          role={commands.length ? "combobox" : undefined}
          aria-autocomplete={commands.length ? "list" : undefined}
          aria-expanded={commands.length ? showCommandMenu : undefined}
          aria-controls={
            showCommandMenu && commandMatches.length ? commandMenuID : undefined
          }
          aria-activedescendant={
            showCommandMenu && commandMatches.length
              ? `${commandMenuID}-${activeCommand}`
              : undefined
          }
          placeholder={placeholder ?? t("messagePlaceholder")}
          aria-label={placeholder ?? t("messagePlaceholder")}
        />
        <div className="composer__toolbar">
          <div className="composer__tools">
            <IconButton
              ref={attachAnchor}
              size="icon-sm"
              className="composer__plus"
              label={t("composerPlus")}
              disabled={!onFiles && plusGroups.length <= 1}
              aria-haspopup="menu"
              aria-expanded={attachOpen}
              onClick={() => {
                setPlusView("menu");
                setAttachOpen((open) => !open);
                setEmojiOpen(false);
                setSendMenuOpen(false);
              }}
            >
              <Plus />
            </IconButton>
            <input
              ref={mediaInput}
              hidden
              type="file"
              accept="image/*,video/*"
              multiple
              onChange={pickFiles}
            />
            <input
              ref={fileInput}
              hidden
              type="file"
              multiple
              onChange={pickFiles}
            />
            <input
              ref={markdownInput}
              hidden
              type="file"
              accept=".md,text/markdown,text/plain"
              multiple
              onChange={pickFiles}
            />
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
                  setVisibleText(
                    `${text}${separator}@`,
                    text.length + separator.length + 1,
                  );
                }}
              >
                <AtSign />
              </IconButton>
            )}
            <button
              type="button"
              className={cx(
                "composer__aa",
                formatOpen && "composer__aa--active",
              )}
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
                {sendOnEnter
                  ? t("composerEnterHint")
                  : t("composerShiftEnterHint")}
              </span>
            )}
            <div
              ref={sendMenuAnchor}
              className={cx(
                "composer__send",
                canSend && "composer__send--active",
              )}
              onContextMenu={(event) => {
                // Right click on send offers the same menu as the arrow.
                event.preventDefault();
                setSendMenuOpen(true);
                setEmojiOpen(false);
                setAttachOpen(false);
              }}
            >
              <button
                type="button"
                className="composer__send-main"
                aria-label={t("send")}
                aria-haspopup={onSchedule || onSendSilent ? "menu" : undefined}
                disabled={!canSend}
                onPointerDown={(event) => {
                  if (event.pointerType === "mouse") return;
                  const state = { timer: 0, fired: false };
                  state.timer = window.setTimeout(() => {
                    state.fired = true;
                    setSendMenuOpen(true);
                  }, 450);
                  longPress.current = state;
                }}
                onPointerUp={() => {
                  if (longPress.current)
                    window.clearTimeout(longPress.current.timer);
                }}
                onPointerCancel={() => {
                  if (longPress.current)
                    window.clearTimeout(longPress.current.timer);
                }}
                onClick={() => {
                  const pressed = longPress.current;
                  longPress.current = null;
                  if (pressed?.fired) return;
                  onSend();
                }}
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
        <FloatingPopover
          anchorRef={attachAnchor}
          placement="top-start"
          width={300}
          onDismiss={() => setAttachOpen(false)}
        >
          {plusView === "agents" ? (
            <Menu label={t("composerChooseAgent")} className="composer-plus">
              <MenuLabel>{t("composerChooseAgent")}</MenuLabel>
              {agents.map((agent) => (
                <button
                  key={agent.actor_id}
                  type="button"
                  role="menuitem"
                  className="composer-plus__agent"
                  onClick={() => callAgent(agent)}
                >
                  <Avatar
                    name={agent.display_name}
                    seed={agent.actor_id}
                    actorID={agent.actor_id}
                    avatarVersion={agent.avatar_version}
                    agent
                    size="sm"
                  />
                  <span className="truncate">{agent.display_name}</span>
                </button>
              ))}
            </Menu>
          ) : (
            <Menu label={t("composerPlus")} className="composer-plus">
              {plusGroups.map((group, index) => (
                <div
                  key={group.id}
                  role="group"
                  aria-label={group.labelKey ? t(group.labelKey) : undefined}
                  className="composer-plus__group"
                >
                  {index > 0 && <MenuDivider />}
                  {group.labelKey && <MenuLabel>{t(group.labelKey)}</MenuLabel>}
                  {group.items.map((item) =>
                    group.id === "attachments" ? (
                      <MenuItem
                        key={item.id}
                        icon={plusIcons[item.id]}
                        disabled={!onFiles || atAttachmentLimit}
                        onClick={() => choosePlus(item.id)}
                      >
                        {t(item.labelKey)}
                      </MenuItem>
                    ) : (
                      <button
                        key={item.id}
                        type="button"
                        role="menuitem"
                        className={cx(
                          "composer-plus__action",
                          item.id === "agent" && "composer-plus__action--agent",
                        )}
                        onClick={() => choosePlus(item.id)}
                      >
                        <span className="composer-plus__glyph" aria-hidden="true">
                          {plusIcons[item.id]}
                        </span>
                        <span className="composer-plus__copy">
                          <strong>{t(item.labelKey)}</strong>
                          {item.hintKey && <small>{t(item.hintKey)}</small>}
                        </span>
                      </button>
                    ),
                  )}
                </div>
              ))}
            </Menu>
          )}
        </FloatingPopover>
      )}
      {emojiOpen && (
        <FloatingPopover
          anchorRef={emojiAnchor}
          placement="top-start"
          width={340}
          className="composer__emoji"
          onDismiss={() => setEmojiOpen(false)}
        >
          <div role="dialog" aria-label={t("emoji")}>
            <EmojiPickerPanel height={360} onPick={insertEmoji} />
          </div>
        </FloatingPopover>
      )}
      {sendMenuOpen && (
        <FloatingPopover
          anchorRef={sendMenuAnchor}
          placement="top-start"
          width={280}
          onDismiss={() => setSendMenuOpen(false)}
        >
          <Menu label={t("sendSettings")}>
            <MenuItem
              checked={sendOnEnter}
              onClick={() => chooseSendMode(true)}
            >
              {t("composerEnterHint")}
            </MenuItem>
            <MenuItem
              checked={!sendOnEnter}
              onClick={() => chooseSendMode(false)}
            >
              {t("composerShiftEnterHint")}
            </MenuItem>
            {(onSchedule || onSendSilent) && <MenuDivider />}
            {onSchedule && (
              <MenuItem
                icon={<Clock3 />}
                disabled={!canSend}
                meta={<ShortcutHint shift />}
                aria-keyshortcuts="Control+Shift+Enter Meta+Shift+Enter"
                onClick={() => {
                  setSendMenuOpen(false);
                  onSchedule();
                }}
              >
                {t("scheduleSendLater")}
              </MenuItem>
            )}
            {onSendSilent && (
              <MenuItem
                icon={<BellOff />}
                disabled={!canSend}
                meta={<ShortcutHint />}
                aria-keyshortcuts="Control+Alt+Enter Meta+Alt+Enter"
                onClick={() => {
                  setSendMenuOpen(false);
                  onSendSilent();
                }}
              >
                {t("scheduleSendSilent")}
              </MenuItem>
            )}
          </Menu>
        </FloatingPopover>
      )}
      {showCommandMenu && (
        <FloatingPopover
          anchorRef={root}
          placement="top-start"
          width={Math.min(420, window.innerWidth - 32)}
          onDismiss={() => setCommandsDismissed(draft.text)}
        >
          <CommandMenu
            id={commandMenuID}
            commands={commandMatches}
            query={typedCommand ?? ""}
            activeIndex={activeCommand}
            onHover={setCommandIndex}
            onPick={insertCommand}
          />
        </FloatingPopover>
      )}
      {showMentionMenu && (
        <FloatingPopover
          anchorRef={root}
          placement="top-start"
          width={departmentSuggestions.length ? 300 : 250}
          onDismiss={() => undefined}
        >
          <Menu label={t("participants")} className="mention-menu">
            {departmentSuggestions.length > 0 && (
              <>
                <MenuLabel>{t("orgMentionDepartments")}</MenuLabel>
                {departmentSuggestions.map((item) => (
                  <button
                    type="button"
                    key={item.department.id}
                    role="menuitem"
                    className="mention-menu__item mention-menu__item--department"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => insertDepartment(item)}
                  >
                    <DepartmentIcon size="sm" />
                    <span className="mention-menu__stack">
                      <strong className="truncate">
                        @{item.department.name}
                      </strong>
                      <span className="mention-menu__meta">
                        {t("orgMentionInChat", { count: item.inChatCount })}
                      </span>
                    </span>
                  </button>
                ))}
                {suggestions.length > 0 && (
                  <MenuLabel>{t("orgMentionPeople")}</MenuLabel>
                )}
              </>
            )}
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
                <button
                  type="button"
                  role="menuitem"
                  className="mention-menu__item"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => insertContextual("all")}
                >
                  <span className="mention-menu__at">@</span>
                  <strong>{t("mentionAll")}</strong>
                  <span className="mention-menu__meta">
                    {t("mentionAllMeta", { count: members.length })}
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="mention-menu__item"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => insertContextual("here")}
                >
                  <span className="mention-menu__at">@</span>
                  <strong>{t("mentionHere")}</strong>
                  <span className="mention-menu__meta">
                    {t("mentionHereMeta", { count: onlineCount })}
                  </span>
                </button>
              </>
            )}
          </Menu>
        </FloatingPopover>
      )}
    </div>
  );
}

const isApple =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** ⌘⇧↵ / ⌘⌥↵ on Apple keyboards, Ctrl+Shift+Enter / Ctrl+Alt+Enter elsewhere. */
function ShortcutHint({ shift = false }: { shift?: boolean }) {
  const keys = isApple
    ? ["⌘", shift ? "⇧" : "⌥", "↵"]
    : ["Ctrl", shift ? "Shift" : "Alt", "Enter"];
  return (
    <kbd className="composer__shortcut" aria-hidden="true">
      {keys.join(isApple ? "" : "+")}
    </kbd>
  );
}
