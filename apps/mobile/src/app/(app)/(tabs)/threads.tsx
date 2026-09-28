import { useCallback, useMemo } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { messagePlainText, type ThreadSummary } from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { useMessenger } from "@/messenger/MessengerProvider";
import { useSignedIn } from "@/session/SessionProvider";
import { useTheme } from "@/lib/theme";
import { chatTitle } from "@/chats/ChatRow";
import { Notice } from "@/ui/Notice";
import { Text } from "@/ui/Text";

export default function ThreadsScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const { api } = useSignedIn();
  const { store } = useMessenger();
  const chats = useStore(store, (state) => state.chats);
  const unread = useStore(store, (state) => state.unread.threads);
  const query = useInfiniteQuery({
    queryKey: ["threads"],
    queryFn: ({ pageParam }) => api.threads(pageParam),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (page) => page.next_before_seq ?? undefined,
  });
  const threads = useMemo(
    () => query.data?.pages.flatMap((page) => page.threads) ?? [],
    [query.data],
  );
  const counts = useMemo(
    () =>
      new Map(unread.map((item) => [item.thread_root_id, item.unread_count])),
    [unread],
  );
  const open = useCallback(
    (item: ThreadSummary) =>
      router.push(`/chat/${item.root.chat_id}/thread/${item.root.id}`),
    [],
  );

  return (
    <SafeAreaView edges={["top"]} style={styles.screen}>
      <Text
        accessibilityRole="header"
        weight="bold"
        size={24}
        style={styles.title}
      >
        {t("tabThreads")}
      </Text>
      <FlatList
        testID="thread-list"
        data={threads}
        keyExtractor={(item) => item.root.id}
        onEndReached={() => {
          if (query.hasNextPage && !query.isFetchingNextPage)
            void query.fetchNextPage();
        }}
        refreshControl={
          <RefreshControl
            refreshing={query.isRefetching}
            onRefresh={() => void query.refetch()}
            tintColor={theme.muted}
          />
        }
        renderItem={({ item }) => {
          const chat = chats[item.root.chat_id];
          const count = counts.get(item.root.id) ?? 0;
          return (
            <Pressable
              accessibilityRole="button"
              onPress={() => open(item)}
              style={({ pressed }) => [
                styles.row,
                { borderBottomColor: theme.border },
                pressed && { backgroundColor: theme.surfaceSelected },
              ]}
            >
              <View style={styles.line}>
                <Text
                  tone="muted"
                  size={13}
                  weight="medium"
                  numberOfLines={1}
                  style={styles.grow}
                >
                  {chat ? chatTitle(chat, t("directChat")) : ""}
                </Text>
                {count > 0 && (
                  <View
                    style={[styles.badge, { backgroundColor: theme.primary }]}
                  >
                    <Text
                      size={13}
                      weight="semibold"
                      style={{ color: theme.onPrimary }}
                    >
                      {count > 99 ? "99+" : count}
                    </Text>
                  </View>
                )}
              </View>
              <Text
                size={16}
                numberOfLines={2}
                weight={count > 0 ? "semibold" : "regular"}
              >
                {item.root.deleted_at
                  ? t("messageDeleted")
                  : messagePlainText(item.root.body)}
              </Text>
              <Text tone="primary" size={14} weight="medium">
                {t("threadReplies", { count: item.reply_count })}
              </Text>
            </Pressable>
          );
        }}
        ListEmptyComponent={
          query.isPending ? (
            <ActivityIndicator style={styles.loader} color={theme.muted} />
          ) : query.isError ? (
            <View style={styles.state}>
              <Notice
                title={t("threadsLoadFailed")}
                actionLabel={t("retry")}
                onAction={() => void query.refetch()}
              />
            </View>
          ) : (
            <View style={styles.state}>
              <Text weight="semibold" size={17}>
                {t("noThreads")}
              </Text>
              <Text tone="muted" size={15}>
                {t("threadsEmptyHint")}
              </Text>
            </View>
          )
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  title: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
    paddingBottom: spacing[3],
  },
  row: {
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    gap: spacing[1],
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  line: { flexDirection: "row", alignItems: "center", gap: spacing[2] },
  grow: { flex: 1 },
  badge: {
    minWidth: 22,
    height: 22,
    paddingHorizontal: 6,
    borderRadius: radius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  loader: { marginTop: spacing[10] },
  state: { padding: spacing[5], gap: spacing[2] },
});
