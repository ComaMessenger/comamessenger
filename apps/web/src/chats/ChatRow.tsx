import { useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { BellOff, Pin } from "lucide-react";
import { useTranslation } from "react-i18next";
import { messagePlainText, type Chat, type ChatFolder } from "@comamessenger/core";
import { Avatar, Badge, countLabel, cx, type Presence } from "../ui";
import { formatListTime } from "../lib/format";
import { chatGlyph, isChatMuted, titleOf } from "../lib/chats";
import { ChatContextMenu, type MenuAnchor } from "./ChatContextMenu";

export function chatPreview(
  chat: Chat,
  ownID: string,
  t: (key: string) => string,
): { sender: string; text: string } {
  const last = chat.last_message;
  if (!last) return { sender: "", text: chat.topic };
  if (last.deleted) return { sender: "", text: t("previewDeleted") };
  const text = messagePlainText(last.body).trim() || t("previewAttachment");
  if (chat.kind === "direct")
    return { sender: last.actor_id === ownID ? `${t("previewYou")}: ` : "", text };
  const name = last.actor_id === ownID ? t("previewYou") : last.actor_display_name;
  return { sender: name ? `${name}: ` : "", text };
}

export function ChatRow({
  chat,
  ownID,
  selected,
  unreadCount,
  mentionCount,
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
          actorID={peer?.actor_id}
          avatarVersion={peer?.avatar_version}
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
