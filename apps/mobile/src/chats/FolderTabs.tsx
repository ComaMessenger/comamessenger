import { useMemo, useState } from "react";
import { Alert, ScrollView, StyleSheet } from "react-native";
import {
  ArrowLeft,
  ArrowRight,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  folderColorToken,
  folderTab,
  matchesTab,
  moveFolder,
  removeFolder,
  tabUnreadCount,
  type Chat,
  type ChatFolder,
  type ChatListTab,
  type UnreadSnapshot,
} from "@comamessenger/core";
import { useTheme } from "@/lib/theme";
import { useMessenger } from "@/messenger/MessengerProvider";
import { MenuSheet, afterSheetCloses } from "@/ui/MenuSheet";
import { TabChip } from "@/ui/TabChip";

const builtIn: { tab: ChatListTab; label: string; always?: boolean }[] = [
  { tab: "all", label: "filterAll", always: true },
  { tab: "unread", label: "filterUnread", always: true },
  { tab: "direct", label: "filterDirect" },
  { tab: "grouped", label: "filterGroups" },
  { tab: "channel", label: "filterChannels" },
];

/**
 * Tabs over the chat list: «All», «Unread», the kinds of chat the person has,
 * then their folders (shared with the web) and «+». Touch and hold a folder
 * to edit, move or delete it.
 */
export function FolderTabs({
  value,
  chats,
  counts,
  onChange,
  onNewFolder,
  onEditFolder,
}: {
  value: ChatListTab;
  chats: Chat[];
  counts: Map<string, UnreadSnapshot["chats"][number]>;
  onChange(tab: ChatListTab): void;
  onNewFolder(): void;
  onEditFolder(folder: ChatFolder): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { folders, saveFolders } = useMessenger();
  const [menuFor, setMenuFor] = useState<ChatFolder | null>(null);

  const tabs = useMemo(
    () => [
      ...builtIn
        // A kind tab appears only when there are chats of that kind.
        .filter(
          ({ tab, always }) =>
            always ||
            chats.some((chat) => matchesTab(chat, tab, folders, counts)),
        )
        .map(({ tab, label }) => ({
          tab,
          label: t(label),
          folder: undefined as ChatFolder | undefined,
        })),
      ...folders.map((folder) => ({
        tab: folderTab(folder.id),
        label: folder.name,
        folder,
      })),
    ],
    [chats, counts, folders, t],
  );

  const failed = () => Alert.alert(t("actionFailed"));
  const save = (next: ChatFolder[]) => void saveFolders(next).catch(failed);
  const index = menuFor
    ? folders.findIndex((folder) => folder.id === menuFor.id)
    : -1;

  function confirmDelete(folder: ChatFolder) {
    Alert.alert(
      t("folderDeleteTitle", { name: folder.name }),
      t("folderDeleteHint"),
      [
        { text: t("cancel"), style: "cancel" },
        {
          text: t("delete"),
          style: "destructive",
          onPress: () => {
            if (value === folderTab(folder.id)) onChange("all");
            save(removeFolder(folders, folder.id));
          },
        },
      ],
    );
  }

  return (
    <>
      <ScrollView
        testID="chat-tabs"
        horizontal
        showsHorizontalScrollIndicator={false}
        accessibilityRole="tablist"
        accessibilityLabel={t("chatTabs")}
        contentContainerStyle={styles.row}
        style={styles.strip}
      >
        {tabs.map(({ tab, label, folder }) => {
          const count = tabUnreadCount(chats, tab, folders, counts);
          return (
            <TabChip
              key={tab}
              testID={`chat-tab-${folder ? `folder-${folder.name}` : tab}`}
              label={label}
              selected={tab === value}
              dot={folder ? theme[folderColorToken(folder.color)] : undefined}
              count={count}
              accessibilityLabel={
                count ? `${label}, ${t("unreadCount", { count })}` : label
              }
              accessibilityHint={folder ? t("chatTabHint") : undefined}
              onPress={() => onChange(tab)}
              onLongPress={folder ? () => setMenuFor(folder) : undefined}
            />
          );
        })}
        <TabChip
          testID="new-folder"
          dashed
          icon={<Plus size={16} color={theme.muted} />}
          accessibilityLabel={t("newFolder")}
          onPress={onNewFolder}
        />
      </ScrollView>
      <MenuSheet
        visible={Boolean(menuFor)}
        title={menuFor?.name}
        testID="folder-actions"
        onClose={() => setMenuFor(null)}
        items={
          menuFor
            ? [
                {
                  key: "edit",
                  label: t("folderEdit"),
                  icon: <Pencil size={20} color={theme.muted} />,
                  onPress: () => afterSheetCloses(() => onEditFolder(menuFor)),
                },
                {
                  key: "left",
                  label: t("folderMoveLeft"),
                  icon: <ArrowLeft size={20} color={theme.muted} />,
                  disabled: index <= 0,
                  onPress: () => save(moveFolder(folders, menuFor.id, -1)),
                },
                {
                  key: "right",
                  label: t("folderMoveRight"),
                  icon: <ArrowRight size={20} color={theme.muted} />,
                  disabled: index < 0 || index >= folders.length - 1,
                  onPress: () => save(moveFolder(folders, menuFor.id, 1)),
                },
                { key: "divider", divider: true },
                {
                  key: "delete",
                  label: t("folderDelete"),
                  icon: <Trash2 size={20} color={theme.danger} />,
                  danger: true,
                  onPress: () => afterSheetCloses(() => confirmDelete(menuFor)),
                },
              ]
            : []
        }
      />
    </>
  );
}

const styles = StyleSheet.create({
  // Prototype: `.folders { gap: 6px; padding: 0 14px 10px }`; the header
  // draws the border under it.
  strip: { flexGrow: 0 },
  row: { gap: 6, paddingHorizontal: 14, paddingBottom: 10 },
});
