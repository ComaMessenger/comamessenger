import { useRef, useState } from "react";
import {
  Bell,
  Bot,
  ChevronDown,
  MessageCircle,
  MessagesSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Star,
  Users,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { hasPermission } from "../settings";
import { Avatar, Badge, IconButton, Kbd, countLabel, cx } from "../ui";
import { useDismissable } from "../lib/useDismissable";
import { useMessenger } from "./MessengerContext";
import { Logo } from "./Logo";
import { WorkspaceMenu } from "./WorkspaceMenu";
import { ProfileMenu } from "./ProfileMenu";

export type PrimarySection =
  | "chats"
  | "threads"
  | "important"
  | "members"
  | "agents"
  | "more"
  | "none";

export function GlobalSidebar({
  active,
  collapsed,
  onToggleCollapsed,
}: {
  active: PrimarySection;
  collapsed: boolean;
  onToggleCollapsed(): void;
}) {
  const { t } = useTranslation();
  const { user, store, navigate, openDialog } = useMessenger();
  const unread = useStore(store, (state) => state.unread);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const workspaceRoot = useRef<HTMLDivElement>(null);
  const profileRoot = useRef<HTMLDivElement>(null);
  useDismissable(workspaceRoot, workspaceOpen, () => setWorkspaceOpen(false));
  useDismissable(profileRoot, profileOpen, () => setProfileOpen(false));

  const unreadChats = unread.chats.reduce(
    (sum, item) => sum + item.unread_count,
    0,
  );
  const unreadThreads = unread.threads.length;
  const items: Array<{
    id: PrimarySection;
    path: string;
    label: string;
    icon: typeof MessageCircle;
    count?: number;
  }> = [
    {
      id: "chats",
      path: "/chats",
      label: t("chats"),
      icon: MessageCircle,
      count: unreadChats,
    },
    {
      id: "threads",
      path: "/threads",
      label: t("threads"),
      icon: MessagesSquare,
      count: unreadThreads,
    },
    { id: "important", path: "/important", label: t("important"), icon: Star },
    { id: "members", path: "/members", label: t("members"), icon: Users },
  ];
  if (hasPermission(user, "agents.manage"))
    items.push({ id: "agents", path: "/agents", label: t("agentsTitle"), icon: Bot });

  return (
    <aside
      className={cx("global-sidebar", collapsed && "global-sidebar--collapsed")}
      aria-label={t("primaryNavigation")}
    >
      <div className="workspace-switcher-root" ref={workspaceRoot}>
        <button
          type="button"
          className="workspace-switcher"
          aria-expanded={workspaceOpen}
          aria-haspopup="menu"
          onClick={() => {
            if (collapsed) onToggleCollapsed();
            setWorkspaceOpen((open) => !open);
          }}
        >
          <Logo size="sm" />
          <strong className="truncate" title={user.organization_name}>
            {user.organization_name}
          </strong>
          <ChevronDown aria-hidden="true" />
        </button>
        {workspaceOpen && !collapsed && (
          <WorkspaceMenu onClose={() => setWorkspaceOpen(false)} />
        )}
      </div>

      <div className="sidebar-actions">
        <button
          type="button"
          className="sidebar-search"
          onClick={() => openDialog({ kind: "search" })}
          aria-label={t("search")}
        >
          <Search aria-hidden="true" />
          <span className="truncate">{t("search")}</span>
          <Kbd>⌘K</Kbd>
        </button>
        <IconButton
          className="sidebar-new"
          variant="primary"
          label={t("newChat")}
          onClick={() => openDialog({ kind: "new-chat" })}
        >
          <Plus strokeWidth={2.2} />
        </IconButton>
      </div>

      <nav className="sidebar-nav" aria-label={t("primaryNavigation")}>
        {items.map((item) => {
          const Icon = item.icon;
          const isActive = active === item.id;
          return (
            <button
              key={item.id}
              type="button"
              className={cx("sidebar-nav__item", isActive && "active")}
              aria-current={isActive ? "page" : undefined}
              title={collapsed ? item.label : undefined}
              onClick={() => navigate(item.path)}
            >
              <Icon aria-hidden="true" />
              <span className="truncate">{item.label}</span>
              {item.count ? (
                <Badge tone={isActive ? "primary" : "neutral"}>
                  {countLabel(item.count)}
                </Badge>
              ) : null}
            </button>
          );
        })}
      </nav>

      <IconButton
        className="sidebar-collapse"
        size="icon-sm"
        label={collapsed ? t("expandSidebar") : t("collapseSidebar")}
        onClick={onToggleCollapsed}
      >
        {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
      </IconButton>

      <div className="sidebar-profile-root" ref={profileRoot}>
        <div className="sidebar-profile">
          <button
            type="button"
            className="sidebar-profile__identity"
            aria-expanded={profileOpen}
            aria-haspopup="menu"
            onClick={() => setProfileOpen((open) => !open)}
          >
            <Avatar
              name={user.display_name}
              seed={user.id}
              actorID={user.id}
              avatarVersion={user.avatar_version}
              size="sm"
              presence="online"
              className="sidebar-profile__avatar"
            />
            <span className="sidebar-profile__copy">
              <strong className="truncate">{user.display_name}</strong>
              <span className="truncate">
                {user.status_text
                  ? `${user.status_emoji} ${user.status_text}`.trim()
                  : `@${user.handle}`}
              </span>
            </span>
          </button>
          <IconButton
            size="icon-sm"
            className="sidebar-profile__bell"
            label={t("notifications")}
            onClick={() => openDialog({ kind: "notifications" })}
          >
            <Bell />
          </IconButton>
        </div>
        {profileOpen && <ProfileMenu onClose={() => setProfileOpen(false)} />}
      </div>
    </aside>
  );
}
