import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { ArrowUpRight, Star, StarOff } from "lucide-react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import {
  applySavedChange,
  defaultImportantTab,
  importantCounts,
  importantTabLabelKeys,
  importantTabs,
  parseImportantTab,
  savedKeys,
  savedMessageHref,
  type ImportantTab,
  type SavedMessagePage,
} from "@comamessenger/core";
import { accountValues } from "@/lib/database";
import { WaitingList } from "@/important/WaitingList";
import { ReminderList } from "@/important/ReminderList";
import { useSignedIn } from "@/session/SessionProvider";
import { useMessenger } from "@/messenger/MessengerProvider";
import { useTheme } from "@/lib/theme";
import { chatTitle } from "@/chats/ChatRow";
import { ImportantRow } from "@/important/ImportantRow";
import { RowBoundary } from "@/ui/RowBoundary";
import { ScreenError } from "@/ui/ScreenError";

/** A render error shows a retry screen instead of closing the app. */
export { ScreenError as ErrorBoundary };
import { useImportant, type ImportantItem } from "@/important/useImportant";
import { MenuSheet } from "@/ui/MenuSheet";
import { Notice } from "@/ui/Notice";
import { TabChip } from "@/ui/TabChip";
import { TabHeader } from "@/ui/TabHeader";
import { Text } from "@/ui/Text";

const lastTabKey = "important_tab";

/**
 * «Важные» as the reader's own inbox: «Ждут вас» (requests waiting for an
 * answer), «Сохранённые» (saved messages, by chat) and «Напоминания».
 * The first two new tabs show only when the server has them. It opens on
 * «Ждут вас» when something waits, else on the tab chosen last.
 */
export default function ImportantScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const { api, user } = useSignedIn();
  const { store } = useMessenger();
  const chatMap = useStore(store, (state) => state.chats);
  const features = useStore(store, (state) => state.features);
  const unread = useStore(store, (state) => state.unread);
  const queryClient = useQueryClient();
  const params = useLocalSearchParams<{ tab?: string }>();
  const tabs = importantTabs(features);
  const counts = importantCounts(unread, features);
  const [chosen, setChosen] = useState<ImportantTab | null>(null);
  const [last, setLast] = useState<ImportantTab | null | undefined>(undefined);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    void accountValues
      .get<string>(lastTabKey)
      .then((value) => setLast(parseImportantTab(value)))
      .catch(() => setLast(null));
  }, []);
  // A push or a link names the tab: it wins once, then the reader chooses.
  const requested = parseImportantTab(params.tab);
  useEffect(() => {
    if (requested) setChosen(requested);
  }, [requested]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 2200);
    return () => clearTimeout(timer);
  }, [notice]);
  const active: ImportantTab =
    chosen && tabs.includes(chosen)
      ? chosen
      : defaultImportantTab({ tabs, counts, last: last ?? null });
  // The tab chosen on opening stays while the screen is in view: answering
  // the last waiting request must not throw the reader to another tab.
  const [focused, setFocused] = useState(true);
  useEffect(() => {
    if (focused && chosen === null && last !== undefined) setChosen(active);
  }, [active, chosen, focused, last]);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => {
        setFocused(false);
        setChosen(null);
      };
    }, []),
  );
  function choose(tab: ImportantTab) {
    setChosen(tab);
    void accountValues.set(lastTabKey, tab).catch(() => undefined);
  }
  const [chatFilter, setChatFilter] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<ImportantItem | null>(null);
  const { query, chats, items, groups, total } = useImportant(chatFilter);

  // Saves made on another device arrive by realtime; refresh on every return
  // to the tab as well (the first visit already loads).
  const { refetch } = query;
  const { refetch: refetchChats } = chats;
  const visited = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (visited.current) {
        void refetch();
        void refetchChats();
      }
      visited.current = true;
    }, [refetch, refetchChats]),
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
    }>({ queryKey: savedKeys.all(user.id) });
    queryClient.setQueriesData<{ pages: SavedMessagePage[] }>(
      { queryKey: [...savedKeys.all(user.id), "list"] },
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
      applySavedChange(queryClient, user.id, {
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
  const countOf = (tab: ImportantTab) =>
    tab === "waiting"
      ? counts.waiting
      : tab === "reminders"
        ? counts.reminders
        : undefined;
  return (
    <View style={[styles.screen, { backgroundColor: theme.surface }]}>
      <TabHeader title={t("tabImportant")}>
        {tabs.length > 1 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            accessibilityRole="tablist"
            contentContainerStyle={styles.chips}
            style={styles.strip}
          >
            {tabs.map((tab) => (
              <TabChip
                key={tab}
                testID={`important-section-${tab}`}
                label={t(importantTabLabelKeys[tab])}
                count={countOf(tab)}
                selected={active === tab}
                onPress={() => choose(tab)}
              />
            ))}
          </ScrollView>
        )}
        {active === "saved" && groups.length > 1 && (
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
      {active === "waiting" ? (
        <WaitingList onNotice={setNotice} />
      ) : active === "reminders" ? (
        <ReminderList onNotice={setNotice} />
      ) : (
        <FlatList
          testID="important-list"
          data={visible}
          keyExtractor={(item) => item.message.id}
          renderItem={({ item, index }) => (
            <RowBoundary kind="message" resetKey={item}>
              <ImportantRow
                testID={`important-row-${index}`}
                item={item}
                onOpen={open}
                onActions={setMenuFor}
              />
            </RowBoundary>
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
      )}
      {notice ? (
        <View
          pointerEvents="none"
          accessibilityLiveRegion="polite"
          style={[styles.notice, { backgroundColor: theme.action }]}
        >
          <Text size={14} weight="medium" style={{ color: theme.onAction }}>
            {notice}
          </Text>
        </View>
      ) : null}
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
  notice: {
    position: "absolute",
    alignSelf: "center",
    bottom: 16,
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 8,
    maxWidth: "90%",
  },
});
