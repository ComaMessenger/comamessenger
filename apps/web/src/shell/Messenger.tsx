import { useCallback, useMemo, useState } from "react";
import type { MessengerAPI, User } from "@comamessenger/core";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import {
  AgentSettingsPage,
  AuditSettingsPage,
  CustomizationSettingsPage,
  InfrastructureSettingsPage,
  NotificationSettingsPage,
  ProfileSettingsPage,
  SecuritySettingsPage,
  WorkspaceGeneralPage,
  WorkspaceInvitationsPage,
  WorkspaceMembersPage,
  WorkspaceOverviewPage,
  WorkspacePoliciesPage,
  settingForPath,
} from "../settings";
import { cx } from "../ui";
import { ChatListPane } from "../chats/ChatListPane";
import { Conversation } from "../conversation/Conversation";
import { ThreadDirectory } from "../directories/ThreadDirectory";
import { ImportantDirectory } from "../directories/ImportantDirectory";
import { MembersDirectory } from "../directories/MembersDirectory";
import { MemberProfilePage } from "../directories/MemberProfilePage";
import { directoryFromPath } from "../directories/routes";
import { MorePage } from "../directories/MorePage";
import { CreateChatDialog } from "../dialogs/CreateChatDialog";
import { ChatFolderDialog } from "../dialogs/ChatFolderDialog";
import { NotificationDialog } from "../dialogs/NotificationDialog";
import { StatusDialog } from "../dialogs/StatusDialog";
import { SearchPalette } from "../dialogs/SearchPalette";
import { writeChatFilterToURL } from "../lib/chats";
import { useIsMobile } from "../lib/useMediaQuery";
import { MessengerContext, type MessengerContextValue, type ShellDialog } from "./MessengerContext";
import { useMessengerSession } from "./useMessengerSession";
import { GlobalSidebar, type PrimarySection } from "./GlobalSidebar";
import { MobileTabBar } from "./MobileTabBar";
import { InAppNotifications } from "./InAppNotifications";
import { ConnectionPill } from "./ConnectionPill";
import { ToastProvider } from "./ToastProvider";
import { Welcome } from "./Welcome";
import { Logo } from "./Logo";

const sidebarStorageKey = "coma-sidebar-collapsed";

function logoSize(size: "small" | "medium" | "large") {
  return size === "small" ? "sm" : size === "medium" ? "md" : "lg";
}

export function Messenger({
  api,
  user,
  path,
  navigate,
  onLogout,
  onUserUpdated,
}: {
  api: MessengerAPI;
  user: User;
  path: string;
  navigate(to: string): void;
  onLogout(): void;
  onUserUpdated(user: User): void;
}) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const session = useMessengerSession({ api, user, path, navigate, onLogout, onUserUpdated });
  const { store, selectedID, threadID } = session;
  const selectedChat = useStore(store, (state) =>
    selectedID ? state.chats[selectedID] : undefined,
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem(sidebarStorageKey) === "true",
  );
  const [dialog, setDialog] = useState<ShellDialog | null>(null);

  const activeSettings = settingForPath(path);
  const showAgents = path === "/agents" || path.startsWith("/agents/");
  const showChatList = Boolean(selectedID) || path === "/chats";
  const directory = directoryFromPath(path);
  const section: PrimarySection = showChatList
    ? "chats"
    : directory
      ? directory.kind
      : showAgents
            ? "agents"
            : path === "/more" || activeSettings
              ? "more"
              : "none";

  const logout = useCallback(async () => {
    await api.logout();
    onLogout();
  }, [api, onLogout]);

  const context = useMemo<MessengerContextValue>(
    () => ({
      api,
      user,
      store,
      coordinator: session.coordinator,
      outbox: session.outbox,
      path,
      navigate,
      reload: session.reload,
      whenReady: session.whenReady,
      scheduleReload: session.scheduleReload,
      onUserUpdated,
      logout,
      folders: session.folders,
      saveFolders: session.saveFolders,
      pinnedChatIDs: session.pinnedChatIDs,
      togglePinnedChat: session.togglePinnedChat,
      snoozedUntil: session.snoozedUntil,
      updateSnooze: session.updateSnooze,
      openDialog: setDialog,
      closeDialog: () => setDialog(null),
    }),
    [
      api,
      user,
      store,
      session.coordinator,
      session.outbox,
      session.reload,
      session.whenReady,
      session.scheduleReload,
      session.folders,
      session.saveFolders,
      session.pinnedChatIDs,
      session.togglePinnedChat,
      session.snoozedUntil,
      session.updateSnooze,
      path,
      navigate,
      onUserUpdated,
      logout,
    ],
  );

  function toggleSidebar() {
    setSidebarCollapsed((collapsed) => {
      localStorage.setItem(sidebarStorageKey, String(!collapsed));
      return !collapsed;
    });
  }

  const workspace = user.must_change_password ? (
    <SecuritySettingsPage api={api} user={user} navigate={navigate} onUserUpdated={onUserUpdated} />
  ) : selectedID ? (
    <Conversation
      key={selectedID}
      chatID={selectedID}
      chat={selectedChat}
      threadID={threadID}
      onBack={() => navigate("/chats")}
      onOpenThread={(id) => navigate(`/chat/${selectedID}/thread/${id}`)}
      onCloseThread={() => navigate(`/chat/${selectedID}`)}
    />
  ) : directory?.kind === "threads" ? (
    <ThreadDirectory selectedID={directory.id} />
  ) : directory?.kind === "important" ? (
    <ImportantDirectory selectedID={directory.id} />
  ) : directory?.kind === "members" ? (
    isMobile && directory.id ? (
      <MemberProfilePage actorID={directory.id} />
    ) : (
      <MembersDirectory selectedID={directory.id} />
    )
  ) : path === "/more" ? (
    <MorePage />
  ) : showAgents ? (
    <AgentSettingsPage api={api} user={user} path={path} navigate={navigate} />
  ) : activeSettings?.id === "profile" ? (
    <ProfileSettingsPage api={api} user={user} navigate={navigate} onLogout={() => void logout()} onUserUpdated={onUserUpdated} />
  ) : activeSettings?.id === "notifications" ? (
    <NotificationSettingsPage api={api} user={user} navigate={navigate} onEnable={() => setDialog({ kind: "notifications" })} />
  ) : activeSettings?.id === "workspace" ? (
    <WorkspaceOverviewPage user={user} navigate={navigate} renderLogo={(size) => <Logo size={logoSize(size)} />} />
  ) : activeSettings?.id === "workspace-general" ? (
    <WorkspaceGeneralPage api={api} user={user} navigate={navigate} />
  ) : activeSettings?.id === "workspace-members" ? (
    <WorkspaceMembersPage api={api} user={user} navigate={navigate} onUserUpdated={onUserUpdated} />
  ) : activeSettings?.id === "workspace-invitations" ? (
    <WorkspaceInvitationsPage api={api} user={user} navigate={navigate} />
  ) : activeSettings?.id === "workspace-policies" ? (
    <WorkspacePoliciesPage api={api} user={user} navigate={navigate} />
  ) : activeSettings?.id === "customization" ? (
    <CustomizationSettingsPage api={api} user={user} navigate={navigate} renderLogo={(size) => <Logo size={logoSize(size)} />} />
  ) : activeSettings?.id === "infrastructure" ? (
    <InfrastructureSettingsPage api={api} user={user} navigate={navigate} />
  ) : activeSettings?.id === "security" ? (
    <SecuritySettingsPage api={api} user={user} navigate={navigate} onUserUpdated={onUserUpdated} />
  ) : activeSettings?.id === "audit" ? (
    <AuditSettingsPage api={api} user={user} navigate={navigate} />
  ) : (
    <Welcome />
  );

  return (
    <MessengerContext.Provider value={context}>
      <ToastProvider>
        <div
          className={cx(
            "messenger",
            sidebarCollapsed && "messenger--sidebar-collapsed",
            !showChatList && "messenger--utility",
            directory && "messenger--directory",
            directory?.id && "messenger--detail-open",
            selectedID && "messenger--chat-open",
            threadID && "messenger--thread-open",
            (showAgents || activeSettings) && "messenger--settings",
          )}
        >
          <InAppNotifications
            items={session.inAppNotifications}
            onOpen={(notification) => {
              session.dismissInAppNotification(notification.id);
              navigate(notification.url);
            }}
            onDismiss={session.dismissInAppNotification}
          />
          {!isMobile && (
            <GlobalSidebar
              active={section}
              collapsed={sidebarCollapsed}
              onToggleCollapsed={toggleSidebar}
            />
          )}
          {showChatList && (
            <ChatListPane
              selectedID={selectedID}
              loading={session.chatLoading}
              error={session.chatError}
              onRetry={() => void session.reload()}
            />
          )}
          <main className="workspace" aria-label={t("chatNavigation")}>
            {workspace}
          </main>
          {isMobile && (
            <MobileTabBar
              active={section === "none" ? "chats" : section === "agents" ? "more" : section}
              compact={Boolean(selectedID)}
              navigate={navigate}
            />
          )}
          {!isMobile && !selectedID && section !== "chats" && (
            <ConnectionPill className="connection-pill--floating" />
          )}
          {dialog?.kind === "new-chat" && (
            <CreateChatDialog
              onClose={() => setDialog(null)}
              onCreated={(chat) => {
                store.setState((state) => ({ chats: { ...state.chats, [chat.id]: chat } }));
                setDialog(null);
                navigate(`/chat/${chat.id}`);
              }}
            />
          )}
          {dialog?.kind === "new-folder" && (
            <ChatFolderDialog
              onClose={() => setDialog(null)}
              onSave={(folder) =>
                session.saveFolders([...session.folders, folder]).then(() => {
                  setDialog(null);
                  writeChatFilterToURL(`folder:${folder.id}`);
                  window.dispatchEvent(new CustomEvent("coma-chat-filter", { detail: `folder:${folder.id}` }));
                })
              }
            />
          )}
          {dialog?.kind === "notifications" && (
            <NotificationDialog onClose={() => setDialog(null)} />
          )}
          {dialog?.kind === "status" && <StatusDialog onClose={() => setDialog(null)} />}
          {dialog?.kind === "search" && (
            <SearchPalette
              request={dialog.request}
              onClose={() => setDialog(null)}
              onOpen={(chatID, messageID) => {
                setDialog(null);
                navigate(`/chat/${chatID}${messageID ? `?message=${messageID}` : ""}`);
              }}
            />
          )}
        </div>
      </ToastProvider>
    </MessengerContext.Provider>
  );
}
