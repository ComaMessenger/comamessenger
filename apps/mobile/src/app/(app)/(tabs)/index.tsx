import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Search } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { matchesFilter, type SystemChatFilter } from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { useMessenger } from "@/messenger/MessengerProvider";
import { useSignedIn } from "@/session/SessionProvider";
import { useTheme } from "@/lib/theme";
import { ChatFilters } from "@/chats/ChatFilters";
import { ChatRow, chatTitle } from "@/chats/ChatRow";
import { ConnectionBanner } from "@/messenger/ConnectionBanner";
import { Notice } from "@/ui/Notice";
import { Text, fonts } from "@/ui/Text";
import { WorkspaceMark } from "@/ui/WorkspaceMark";

export default function ChatsScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const { user } = useSignedIn();
  const { store, reload, chatLoading, chatError, pinnedChatIDs } =
    useMessenger();
  const chatMap = useStore(store, (state) => state.chats);
  const unread = useStore(store, (state) => state.unread);
  const presence = useStore(store, (state) => state.presence);
  const [filter, setFilter] = useState<SystemChatFilter>("all");
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const counts = useMemo(
    () => new Map(unread.chats.map((item) => [item.chat_id, item])),
    [unread],
  );
  const chats = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const pinned = new Map(pinnedChatIDs.map((id, index) => [id, index]));
    return Object.values(chatMap)
      .filter(
        (chat) =>
          matchesFilter(chat, filter, undefined) &&
          (!needle || chatTitle(chat, "").toLocaleLowerCase().includes(needle)),
      )
      .sort((left, right) => {
        const leftPin = pinned.get(left.id) ?? Infinity;
        const rightPin = pinned.get(right.id) ?? Infinity;
        if (leftPin !== rightPin) return leftPin - rightPin;
        return (right.last_message_at ?? right.created_at).localeCompare(
          left.last_message_at ?? left.created_at,
        );
      });
  }, [chatMap, filter, pinnedChatIDs, query]);

  const open = useCallback(
    (chatID: string) => router.push(`/chat/${chatID}`),
    [],
  );
  const refresh = useCallback(async () => {
    setRefreshing(true);
    await reload();
    setRefreshing(false);
  }, [reload]);

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
      <Text weight="semibold" size={17}>
        {query || filter !== "all" ? t("noChatsFound") : t("noChats")}
      </Text>
      {!query && filter === "all" && (
        <Text tone="muted" size={15}>
          {t("noChatsHint")}
        </Text>
      )}
    </View>
  );

  return (
    <SafeAreaView edges={["top"]} style={styles.screen}>
      <View style={styles.header}>
        <WorkspaceMark name={user.organization_name} size={40} />
        <Text
          accessibilityRole="header"
          weight="bold"
          size={24}
          numberOfLines={1}
          style={styles.grow}
        >
          {user.organization_name}
        </Text>
      </View>
      <View style={[styles.search, { backgroundColor: theme.sidebar }]}>
        <Search size={20} color={theme.subtle} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={t("searchChats")}
          placeholderTextColor={theme.subtle}
          accessibilityLabel={t("searchChats")}
          clearButtonMode="while-editing"
          returnKeyType="search"
          style={[styles.searchInput, { color: theme.foreground }]}
        />
      </View>
      <View style={styles.filters}>
        <ChatFilters value={filter} onChange={setFilter} />
      </View>
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
              presence={
                item.direct_peer
                  ? presence[item.direct_peer.actor_id]
                  : undefined
              }
              onOpen={open}
            />
          );
        }}
        ListEmptyComponent={empty}
        keyboardDismissMode="on-drag"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void refresh()}
            tintColor={theme.muted}
          />
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
    paddingBottom: spacing[3],
  },
  grow: { flex: 1 },
  search: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[2],
    marginHorizontal: spacing[4],
    paddingHorizontal: spacing[4],
    height: 44,
    borderRadius: radius.lg,
  },
  searchInput: { flex: 1, fontFamily: fonts.regular, fontSize: 17 },
  filters: { paddingVertical: spacing[3] },
  loader: { marginTop: spacing[10] },
  state: { padding: spacing[5], gap: spacing[2], alignItems: "stretch" },
});
