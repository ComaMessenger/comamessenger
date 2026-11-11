import { Alert, StyleSheet, View } from "react-native";
import {
  Bell,
  BellOff,
  FolderPlus,
  LogOut,
  MailOpen,
  Pin,
  PinOff,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import {
  folderColorToken,
  hasUnread,
  isChatMuted,
  pinnedChatLimit,
  toggleChatInFolder,
  unreadByChat,
} from "@comamessenger/core";
import { useTheme } from "@/lib/theme";
import { useMessenger } from "@/messenger/MessengerProvider";
import { useSignedIn } from "@/session/SessionProvider";
import {
  MenuSheet,
  afterSheetCloses,
  type MenuSheetItem,
} from "@/ui/MenuSheet";
import { chatTitle } from "./ChatRow";

/**
 * Long-press menu of a chat row: the web context menu actions that have an
 * API — pin, mute, mark as read, folders, leave.
 */
export function ChatActionsSheet({
  chatID,
  onClose,
  onNewFolder,
}: {
  chatID: string | null;
  onClose(): void;
  /** Opens the folder sheet with this chat ticked. */
  onNewFolder(chatID: string): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { api, user } = useSignedIn();
  const {
    store,
    reload,
    pinnedChatIDs,
    togglePinnedChat,
    folders,
    saveFolders,
  } = useMessenger();
  const chat = useStore(store, (state) =>
    chatID ? state.chats[chatID] : undefined,
  );
  const unread = useStore(store, (state) => state.unread);
  if (!chat) return <MenuSheet visible={false} items={[]} onClose={onClose} />;

  const title = chatTitle(chat, t("directChat"));
  const pinned = pinnedChatIDs.includes(chat.id);
  const muted = isChatMuted(chat);
  const failed = () => Alert.alert(t("actionFailed"));
  const icon = (Glyph: typeof Pin, danger = false) => (
    <Glyph size={20} color={danger ? theme.danger : theme.muted} />
  );

  const items: MenuSheetItem[] = [
    {
      key: "pin",
      testID: "chat-action-pin",
      label: pinned ? t("unpinChat") : t("pinChat"),
      icon: icon(pinned ? PinOff : Pin),
      meta: t("pinSlots", {
        used: pinnedChatIDs.length,
        limit: pinnedChatLimit,
      }),
      disabled: !pinned && pinnedChatIDs.length >= pinnedChatLimit,
      onPress: () =>
        void togglePinnedChat(chat.id)
          .then((done) => {
            if (!done) Alert.alert(t("pinLimit", { limit: pinnedChatLimit }));
          })
          .catch(failed),
    },
    {
      key: "mute",
      testID: "chat-action-mute",
      label: muted ? t("unmuteChat") : t("muteChat"),
      icon: icon(muted ? Bell : BellOff),
      onPress: () =>
        void api
          .updateChatNotifications(chat.id, {
            notify_level: muted ? "default" : "none",
            muted_until: null,
          })
          .then(() => reload())
          .catch(failed),
    },
  ];
  if (hasUnread(unreadByChat(unread).get(chat.id)))
    items.push({
      key: "read",
      testID: "chat-action-read",
      label: t("markAsRead"),
      icon: icon(MailOpen),
      onPress: () =>
        void api
          .markRead(chat.id, chat.last_activity_seq)
          .then(() => reload())
          .catch(failed),
    });
  items.push({ key: "folders", divider: true, label: t("inFolders") });
  for (const folder of folders)
    items.push({
      key: `folder:${folder.id}`,
      label: folder.name,
      icon: (
        <View
          style={[
            styles.dot,
            { backgroundColor: theme[folderColorToken(folder.color)] },
          ]}
        />
      ),
      checked: folder.chat_ids.includes(chat.id),
      onPress: () =>
        void saveFolders(toggleChatInFolder(folders, folder.id, chat.id)).catch(
          failed,
        ),
    });
  items.push({
    key: "new-folder",
    label: t("newFolder"),
    icon: icon(FolderPlus),
    onPress: () => afterSheetCloses(() => onNewFolder(chat.id)),
  });
  if (chat.kind !== "direct") {
    const channel = chat.kind === "channel";
    items.push({ key: "leave-divider", divider: true });
    items.push({
      key: "leave",
      label: channel ? t("leaveChannelAction") : t("leaveGroupAction"),
      icon: icon(LogOut, true),
      danger: true,
      onPress: () =>
        afterSheetCloses(() =>
          Alert.alert(
            t("leaveGroupTitle", { name: title }),
            channel ? t("leaveChannelHint") : t("leaveGroupHint"),
            [
              { text: t("cancel"), style: "cancel" },
              {
                text: channel ? t("leaveChannelAction") : t("leaveGroupAction"),
                style: "destructive",
                onPress: () =>
                  void api
                    .removeMember(chat.id, user.id)
                    .then(() => reload())
                    .catch(failed),
              },
            ],
          ),
        ),
    });
  }

  return (
    <MenuSheet
      visible
      testID="chat-actions"
      title={title}
      items={items}
      onClose={onClose}
    />
  );
}

const styles = StyleSheet.create({
  // Centred in the 20px icon column.
  dot: { width: 10, height: 10, borderRadius: 5, marginHorizontal: 5 },
});
