import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  View,
} from "react-native";
import { router } from "expo-router";
import { Search, SquarePen } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import {
  folderOfTab,
  matchesTab,
  resolveTab,
  sortChats,
  upsertFolder,
  unreadByChat,
  type ChatFolder,
  type ChatListTab,
} from "@comamessenger/core";
import { useMessenger } from "@/messenger/MessengerProvider";
import { useSignedIn } from "@/session/SessionProvider";
import { useTheme } from "@/lib/theme";
import { ChatActionsSheet } from "@/chats/ChatActionsSheet";
import { ChatRow } from "@/chats/ChatRow";
import { FolderSheet } from "@/chats/FolderSheet";
import { FolderTabs } from "@/chats/FolderTabs";
import { useChatDrafts } from "@/chats/useChatDrafts";
import { ConnectionBanner } from "@/messenger/ConnectionBanner";
import { Notice } from "@/ui/Notice";
import { IconButton } from "@/ui/IconButton";
import { TabHeader } from "@/ui/TabHeader";
import { Text } from "@/ui/Text";
import { WorkspaceMark } from "@/ui/WorkspaceMark";

type FolderEditor = { folder?: ChatFolder; chatIDs?: string[] } | null;

export default function ChatsScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const { user } = useSignedIn();
  const {
    store,
    reload,
    chatLoading,
    chatError,
    pinnedChatIDs,
    folders,
    saveFolders,
  } = useMessenger();
  const chatMap = useStore(store, (state) => state.chats);
  const unread = useStore(store, (state) => state.unread);
  const presence = useStore(store, (state) => state.presence);
  const drafts = useChatDrafts();
  const [selectedTab, setTab] = useState<ChatListTab>("all");
  const [refreshing, setRefreshing] = useState(false);
  const [actionsFor, setActionsFor] = useState<string | null>(null);
  const [editor, setEditor] = useState<FolderEditor>(null);

  const tab = resolveTab(selectedTab, folders);
  const counts = useMemo(() => unreadByChat(unread), [unread]);
  const allChats = useMemo(() => Object.values(chatMap), [chatMap]);
  const chats = useMemo(
    () =>
      sortChats(
        allChats.filter((chat) => matchesTab(chat, tab, folders, counts)),
        pinnedChatIDs,
      ),
    [allChats, counts, folders, pinnedChatIDs, tab],
  );
  const pinned = useMemo(() => new Set(pinnedChatIDs), [pinnedChatIDs]);

  const open = useCallback(
    (chatID: string) => router.push(`/chat/${chatID}`),
    [],
  );
  const refresh = useCallback(async () => {
    setRefreshing(true);
    await reload();
    setRefreshing(false);
  }, [reload]);

  const activeFolder = folderOfTab(tab, folders);
  const empty = chatLoading ? (
    <ActivityIndicator style={styles.loader} color={theme.muted} />
  ) : chatError ? (
    <View style={styles.state}>
      <Notice
        title={t("chatsLoadFailed")}
        hint={chatError}
        actionLabel={t("retry")}
        onAction={() => void reload()}
      />
    </View>
  ) : (
    <View style={styles.state}>
      <Text weight="semibold" size={17} style={styles.center}>
        {tab === "all"
          ? t("noChats")
          : tab === "unread"
            ? t("unreadEmpty")
            : activeFolder
              ? t("folderEmpty")
              : t("noChatsFound")}
      </Text>
      {(tab === "all" || activeFolder) && (
        <Text tone="muted" size={15} style={styles.center}>
          {tab === "all" ? t("noChatsHint") : t("folderEmptyHint")}
        </Text>
      )}
    </View>
  );

  return (
    <View style={[styles.screen, { backgroundColor: theme.surface }]}>
      <TabHeader
        title={t("tabChats")}
        leading={<WorkspaceMark name={user.organization_name} size={34} />}
        trailing={
          <IconButton
            testID="new-message"
            variant="soft"
            label={t("newMessage")}
            hint={t("newMessageHint")}
            onPress={() => router.push("/new-chat")}
            icon={(color) => <SquarePen size={20} color={color} />}
          />
        }
      >
        <Pressable
          testID="open-search"
          accessibilityRole="search"
          accessibilityLabel={t("searchMessagesAndFiles")}
          onPress={() => router.push("/search")}
          style={({ pressed }) => [
            styles.search,
            {
              backgroundColor: theme.surfaceSelected,
              opacity: pressed ? 0.7 : 1,
            },
          ]}
        >
          <Search size={18} color={theme.muted} />
          <Text tone="muted" size={15} numberOfLines={1}>
            {t("searchMessagesAndFiles")}
          </Text>
        </Pressable>
        <FolderTabs
          value={tab}
          chats={allChats}
          counts={counts}
          onChange={setTab}
          onNewFolder={() => setEditor({})}
          onEditFolder={(folder) => setEditor({ folder })}
        />
      </TabHeader>
      <ConnectionBanner />
      <FlatList
        testID="chat-list"
        data={chats}
        keyExtractor={(chat) => chat.id}
        renderItem={({ item, index }) => {
          const count = counts.get(item.id);
          return (
            <ChatRow
              testID={`chat-row-${index}`}
              chat={item}
              ownID={user.id}
              unreadCount={count?.unread_count ?? 0}
              mentionCount={count?.mention_count ?? 0}
              pinned={pinned.has(item.id)}
              draft={drafts[item.id]}
              presence={
                item.direct_peer
                  ? presence[item.direct_peer.actor_id]
                  : undefined
              }
              onOpen={open}
              onActions={setActionsFor}
            />
          );
        }}
        ListEmptyComponent={empty}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void refresh()}
            tintColor={theme.muted}
          />
        }
      />
      <ChatActionsSheet
        chatID={actionsFor}
        onClose={() => setActionsFor(null)}
        onNewFolder={(chatID) => setEditor({ chatIDs: [chatID] })}
      />
      <FolderSheet
        visible={editor !== null}
        folder={editor?.folder}
        initialChatIDs={editor?.chatIDs}
        onClose={() => setEditor(null)}
        onSave={async (folder) => {
          await saveFolders(upsertFolder(folders, folder));
          if (!editor?.folder) setTab(`folder:${folder.id}`);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  // Prototype: `.search { margin: 0 14px 10px; height: 38px; border-radius: 12px }`.
  search: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 38,
    marginHorizontal: 14,
    marginBottom: 10,
    paddingHorizontal: 12,
    borderRadius: 12,
  },
  loader: { marginTop: 40 },
  state: { padding: 20, gap: 8, alignItems: "stretch" },
  center: { textAlign: "center" },
});
