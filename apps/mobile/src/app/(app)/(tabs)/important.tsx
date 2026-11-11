import { useCallback, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { router, useFocusEffect } from "expo-router";
import { ArrowUpRight, Star, StarOff } from "lucide-react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import {
  applySavedChange,
  savedKeys,
  savedMessageHref,
  type SavedMessagePage,
} from "@comamessenger/core";
import { useSignedIn } from "@/session/SessionProvider";
import { useMessenger } from "@/messenger/MessengerProvider";
import { useTheme } from "@/lib/theme";
import { chatTitle } from "@/chats/ChatRow";
import { ImportantRow } from "@/important/ImportantRow";
import { useImportant, type ImportantItem } from "@/important/useImportant";
import { MenuSheet } from "@/ui/MenuSheet";
import { Notice } from "@/ui/Notice";
import { TabChip } from "@/ui/TabChip";
import { TabHeader } from "@/ui/TabHeader";
import { Text } from "@/ui/Text";

export default function ImportantScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const { api } = useSignedIn();
  const { store } = useMessenger();
  const chatMap = useStore(store, (state) => state.chats);
  const queryClient = useQueryClient();
  const [chatFilter, setChatFilter] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<ImportantItem | null>(null);
  const { query, all, items, groups, total } = useImportant(chatFilter);

  // Saves made on another device arrive by realtime; refresh on every return
  // to the tab as well (the first visit already loads).
  const { refetch } = all;
  const visited = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (visited.current) void refetch();
      visited.current = true;
    }, [refetch]),
  );

  // A chat chip asks the server for that chat, so older saves are found too.
  const filter = chatFilter;
  const visible = items;

  const open = useCallback(
    (item: ImportantItem) => router.push(savedMessageHref(item) as never),
    [],
  );

  async function remove(item: ImportantItem) {
    const previous = queryClient.getQueriesData<{
      pages: SavedMessagePage[];
    }>({ queryKey: savedKeys.all });
    queryClient.setQueriesData<{ pages: SavedMessagePage[] }>(
      { queryKey: ["saved", "list"] },
      (data) =>
        data && {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            items: page.items.filter(
              (entry) => entry.message.id !== item.message.id,
            ),
          })),
        },
    );
    try {
      await api.unsaveMessage(item.message.id);
      applySavedChange(queryClient, {
        messageID: item.message.id,
        chatID: item.chat.id,
        saved: false,
      });
    } catch {
      for (const [key, data] of previous) queryClient.setQueryData(key, data);
      Alert.alert(t("actionFailed"));
    }
  }

  const loading = query.isPending && query.fetchStatus !== "idle";
  return (
    <View style={[styles.screen, { backgroundColor: theme.surface }]}>
      <TabHeader title={t("tabImportant")}>
        {groups.length > 1 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            accessibilityRole="tablist"
            contentContainerStyle={styles.chips}
            style={styles.strip}
          >
            <TabChip
              testID="important-tab-all"
              label={t("importantAllChats")}
              count={total}
              selected={filter === null}
              onPress={() => setChatFilter(null)}
            />
            {groups.map(({ chat, count }) => (
              <TabChip
                key={chat.id}
                label={
                  chatMap[chat.id]
                    ? chatTitle(chatMap[chat.id]!, t("directChat"))
                    : chat.display_name || t("directChat")
                }
                count={count}
                selected={filter === chat.id}
                onPress={() => setChatFilter(chat.id)}
              />
            ))}
          </ScrollView>
        )}
      </TabHeader>
      <FlatList
        testID="important-list"
        data={visible}
        keyExtractor={(item) => item.message.id}
        renderItem={({ item, index }) => (
          <ImportantRow
            testID={`important-row-${index}`}
            item={item}
            onOpen={open}
            onActions={setMenuFor}
          />
        )}
        onEndReached={() => {
          if (query.hasNextPage && !query.isFetchingNextPage)
            void query.fetchNextPage();
        }}
        onEndReachedThreshold={0.5}
        ListFooterComponent={
          query.isFetchingNextPage ? (
            <ActivityIndicator style={styles.more} color={theme.muted} />
          ) : null
        }
        refreshControl={
          <RefreshControl
            refreshing={query.isRefetching}
            onRefresh={() => void query.refetch()}
            tintColor={theme.muted}
          />
        }
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator style={styles.loader} color={theme.muted} />
          ) : query.isError ? (
            <View style={styles.state}>
              <Notice
                title={t("importantLoadFailed")}
                actionLabel={t("retry")}
                onAction={() => void query.refetch()}
              />
            </View>
          ) : (
            <View style={styles.empty}>
              <View
                style={[
                  styles.emptyIcon,
                  { backgroundColor: theme.surfaceSelected },
                ]}
              >
                <Star size={26} color={theme.muted} />
              </View>
              <Text weight="semibold" size={17} style={styles.center}>
                {t("importantEmpty")}
              </Text>
              <Text tone="muted" size={15} style={styles.center}>
                {t("importantSavedHint")}
              </Text>
            </View>
          )
        }
      />
      <MenuSheet
        visible={Boolean(menuFor)}
        testID="important-actions"
        onClose={() => setMenuFor(null)}
        items={
          menuFor
            ? [
                {
                  key: "open",
                  label: t("importantOpen"),
                  icon: <ArrowUpRight size={20} color={theme.muted} />,
                  onPress: () => open(menuFor),
                },
                {
                  key: "remove",
                  testID: "important-remove",
                  label: t("importantRemove"),
                  icon: <StarOff size={20} color={theme.danger} />,
                  danger: true,
                  onPress: () => void remove(menuFor),
                },
              ]
            : []
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  strip: { flexGrow: 0 },
  chips: { gap: 6, paddingHorizontal: 14, paddingBottom: 10 },
  loader: { marginTop: 40 },
  more: { marginVertical: 16 },
  state: { padding: 20 },
  empty: {
    paddingHorizontal: 32,
    paddingTop: 56,
    gap: 8,
    alignItems: "center",
  },
  emptyIcon: {
    width: 56,
    height: 56,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 6,
  },
  center: { textAlign: "center" },
});
