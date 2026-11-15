import { useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { BellOff, ListChecks, MessageSquareMore, Pin } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  chatAvatarSource,
  chatPreview as corePreview,
  formatRequestDueDay,
  type Chat,
  type ChatFolder,
  type ChatRequestBadge,
  type ChatTaskBadge,
} from "@comamessenger/core";
import { calendarLocale } from "../requests/format";
import { formatTaskBadgeDue } from "../tasks/format";
import { Avatar, Badge, countLabel, cx, type Presence } from "../ui";
import { formatListTime } from "../lib/format";
import { chatGlyph, isChatMuted, titleOf } from "../lib/chats";
import { ChatContextMenu, type MenuAnchor } from "./ChatContextMenu";

export function chatPreview(
  chat: Chat,
  ownID: string,
  t: (key: string) => string,
): { sender: string; text: string } {
  return corePreview(chat, ownID, {
    you: t("previewYou"),
    deleted: t("previewDeleted"),
    attachment: t("previewAttachment"),
    voice: t("previewVoice"),
  });
}

export function ChatRow({
  chat,
  ownID,
  selected,
  unreadCount,
  mentionCount,
  requestBadge = null,
  taskBadge = null,
  pinned,
  pinnedCount,
  presence,
  folders,
  onOpen,
  onTogglePin,
  onToggleMute,
  onMarkRead,
  onToggleFolder,
  onLeave,
}: {
  chat: Chat;
  ownID: string;
  selected: boolean;
  unreadCount: number;
  mentionCount: number;
  /** answer by Fri or awaiting answer: requests wait for the reader here. */
  requestBadge?: ChatRequestBadge | null;
  /** task by 12:00 / task overdue: wins over the request mark. */
  taskBadge?: ChatTaskBadge | null;
  pinned: boolean;
  pinnedCount: number;
  presence?: Presence;
  folders: ChatFolder[];
  onOpen(): void;
  onTogglePin(): void;
  onToggleMute(): void;
  onMarkRead(): void;
  onToggleFolder(folderID: string): void;
  onLeave(): void;
}) {
  const { t } = useTranslation();
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const longPress = useRef<number | null>(null);
  const longPressed = useRef(false);
  const title = titleOf(chat, [], ownID);
  const muted = isChatMuted(chat);
  const preview = chatPreview(chat, ownID, t);
  const peer = chat.direct_peer;
  const time = chat.last_message_at ?? chat.created_at;

  function openContextMenu(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY });
  }
  function clearLongPress() {
    if (longPress.current !== null) window.clearTimeout(longPress.current);
    longPress.current = null;
  }
  function startLongPress(event: PointerEvent) {
    if (event.pointerType !== "touch") return;
    const { clientX, clientY } = event;
    longPress.current = window.setTimeout(() => {
      longPressed.current = true;
      setMenu({ x: clientX, y: clientY });
    }, 520);
  }

  return (
    <>
      <button
        type="button"
        className={cx(
          "chat-row",
          selected && "chat-row--selected",
          unreadCount > 0 && "chat-row--unread",
          muted && "chat-row--muted",
        )}
        aria-current={selected ? "true" : undefined}
        aria-haspopup="menu"
        aria-expanded={Boolean(menu)}
        onClick={(event) => {
          if (longPressed.current) {
            event.preventDefault();
            longPressed.current = false;
            return;
          }
          onOpen();
        }}
        onContextMenu={openContextMenu}
        onKeyDown={(event) => {
          if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
          event.preventDefault();
          const bounds = event.currentTarget.getBoundingClientRect();
          setMenu({ x: bounds.left + 56, y: bounds.top + 28 });
        }}
        onPointerDown={startLongPress}
        onPointerUp={clearLongPress}
        onPointerCancel={clearLongPress}
        onPointerMove={clearLongPress}
      >
        <Avatar
          name={title}
          seed={chat.avatar_seed}
          {...chatAvatarSource(chat)}
          agent={peer?.type === "agent"}
          glyph={chatGlyph(chat)}
          presence={chat.kind === "direct" && peer?.type !== "agent" ? presence : undefined}
          size="lg"
          className="chat-row__avatar"
        />
        <span className="chat-row__body">
          <span className="chat-row__top">
            <strong className="truncate">{title}</strong>
            {muted && <BellOff className="chat-row__muted" aria-label={t("muted")} />}
            <time
              className={cx("chat-row__time", mentionCount > 0 && "chat-row__time--mention")}
              dateTime={time}
            >
              {formatListTime(time)}
            </time>
          </span>
          <span className="chat-row__bottom">
            <span className="chat-row__preview truncate">
              {preview.sender && <span className="chat-row__sender">{preview.sender}</span>}
              {preview.text}
            </span>
            {taskBadge ? (
              <span className="chat-row__need chat-row__need--task">
                <ListChecks aria-hidden="true" />
                {taskBadge.kind === "overdue"
                  ? t("taskBadgeOverdue")
                  : t("taskBadgeDue", {
                      when: formatTaskBadgeDue(taskBadge.at, new Date()),
                    })}
              </span>
            ) : requestBadge && (
              <span className="chat-row__need">
                <MessageSquareMore aria-hidden="true" />
                {requestBadge.kind === "due"
                  ? t("requestBadgeDue", {
                      when: formatRequestDueDay(
                        requestBadge.at,
                        new Date(),
                        calendarLocale(),
                      ),
                    })
                  : t("requestBadgeWaiting")}
              </span>
            )}
            {unreadCount > 0 ? (
              <Badge tone={mentionCount > 0 ? "primary" : "neutral"}>
                {countLabel(unreadCount)}
              </Badge>
            ) : pinned ? (
              <Pin className="chat-row__pin" aria-label={t("pinnedChat")} />
            ) : null}
          </span>
        </span>
      </button>
      {menu && (
        <ChatContextMenu
          chat={chat}
          anchor={menu}
          pinned={pinned}
          pinnedCount={pinnedCount}
          muted={muted}
          unread={unreadCount > 0}
          folders={folders}
          onClose={() => setMenu(null)}
          onTogglePin={onTogglePin}
          onToggleMute={onToggleMute}
          onMarkRead={onMarkRead}
          onToggleFolder={onToggleFolder}
          onLeave={onLeave}
        />
      )}
    </>
  );
}
