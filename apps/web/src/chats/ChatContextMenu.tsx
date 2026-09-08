import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import {
  Bell,
  BellOff,
  ExternalLink,
  LogOut,
  MessageCircle,
  Pin,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Chat, ChatFolder } from "@comamessenger/core";
import { Menu, MenuDivider, MenuItem } from "../ui";
import { useDismissable } from "../lib/useDismissable";
import { pinnedChatLimit } from "../shell/useMessengerSession";

export type MenuAnchor = { x: number; y: number };

export function ChatContextMenu({
  chat,
  anchor,
  pinned,
  pinnedCount,
  muted,
  unread,
  folders,
  onClose,
  onTogglePin,
  onToggleMute,
  onMarkRead,
  onToggleFolder,
  onLeave,
}: {
  chat: Chat;
  anchor: MenuAnchor;
  pinned: boolean;
  pinnedCount: number;
  muted: boolean;
  unread: boolean;
  folders: ChatFolder[];
  onClose(): void;
  onTogglePin(): void;
  onToggleMute(): void;
  onMarkRead(): void;
  onToggleFolder(folderID: string): void;
  onLeave(): void;
}) {
  const { t } = useTranslation();
  const root = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({
    left: anchor.x,
    top: anchor.y,
    visibility: "hidden",
  });
  useDismissable(root, true, onClose);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const box = element.getBoundingClientRect();
    const edge = 8;
    setStyle({
      left: Math.max(edge, Math.min(anchor.x, window.innerWidth - box.width - edge)),
      top: Math.max(edge, Math.min(anchor.y, window.innerHeight - box.height - edge)),
      visibility: "visible",
    });
  }, [anchor.x, anchor.y]);
  const canPin = pinned || pinnedCount < pinnedChatLimit;
  function run(action: () => void) {
    onClose();
    action();
  }
  return createPortal(
    <div ref={root} className="chat-context-menu" style={style}>
      <Menu label={t("chatContextMenu")}>
        <MenuItem
          icon={<ExternalLink />}
          onClick={() =>
            run(() =>
              window.open(
                new URL(`/chat/${chat.id}`, window.location.origin),
                "_blank",
                "noopener,noreferrer",
              ),
            )
          }
        >
          {t("openNewWindow")}
        </MenuItem>
        <MenuItem
          icon={<Pin />}
          disabled={!canPin}
          meta={t("pinSlots", { used: pinnedCount, limit: pinnedChatLimit })}
          onClick={() => run(onTogglePin)}
        >
          {pinned ? t("unpinChat") : t("pinChat")}
        </MenuItem>
        <MenuItem icon={muted ? <Bell /> : <BellOff />} onClick={() => run(onToggleMute)}>
          {muted ? t("unmuteChat") : t("muteChat")}
        </MenuItem>
        {unread && (
          <MenuItem icon={<MessageCircle />} onClick={() => run(onMarkRead)}>
            {t("markAsRead")}
          </MenuItem>
        )}
        {folders.length > 0 && <MenuDivider />}
        {folders.map((folder) => {
          const included = folder.chat_ids.includes(chat.id);
          return (
            <MenuItem
              key={folder.id}
              role="menuitemcheckbox"
              checked={included}
              icon={<span className="ui-chip__dot" data-folder-color={folder.color} />}
              onClick={() => run(() => onToggleFolder(folder.id))}
            >
              {folder.name}
            </MenuItem>
          );
        })}
        {chat.kind !== "direct" && (
          <>
            <MenuDivider />
            <MenuItem danger icon={<LogOut />} onClick={() => run(onLeave)}>
              {chat.kind === "channel" ? t("leaveChannelAction") : t("leaveGroupAction")}
            </MenuItem>
          </>
        )}
      </Menu>
    </div>,
    document.body,
  );
}
