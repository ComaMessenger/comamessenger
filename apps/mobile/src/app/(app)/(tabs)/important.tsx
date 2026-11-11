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
import { ArrowUpRight, PinOff, Star } from "lucide-react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useSignedIn } from "@/session/SessionProvider";
import { useTheme } from "@/lib/theme";
import { chatTitle } from "@/chats/ChatRow";
import { ImportantRow } from "@/important/ImportantRow";
import {
  canUnpin,
  chatsWithPins,
  importantHref,
  type ImportantItem,
} from "@/important/pins";
import { importantKey, useImportant } from "@/important/useImportant";
import { MenuSheet } from "@/ui/MenuSheet";
import { Notice } from "@/ui/Notice";
import { TabChip } from "@/ui/TabChip";
import { TabHeader } from "@/ui/TabHeader";
import { Text } from "@/ui/Text";

export default function ImportantScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const { api, user } = useSignedIn();
  const queryClient = useQueryClient();
  const query = useImportant();
  const [chatFilter, setChatFilter] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<ImportantItem | null>(null);

  // Pins change in other chats and on other devices; refresh on every return
  // to the tab (the first visit already loads).
  const { refetch } = query;
  const visited = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (visited.current) void refetch();
      visited.current = true;
    }, [refetch]),
  );

  const items = useMemo(() => query.data ?? [], [query.data]);
  const groups = useMemo(() => chatsWithPins(items), [items]);
  const filter =
    chatFilter && groups.some((group) => group.chat.id === chatFilter)
      ? chatFilter
      : null;
  const visible = filter
    ? items.filter((item) => item.chat.id === filter)
    : items;

  const open = useCallback(
    (item: ImportantItem) => router.push(importantHref(item) as never),
    [],
  );

  async function remove(item: ImportantItem) {
    const previous = queryClient.getQueriesData<ImportantItem[]>({
      queryKey: importantKey,
    });
    queryClient.setQueriesData<ImportantItem[]>(
      { queryKey: importantKey },
      (data) => data?.filter((entry) => entry.message.id !== item.message.id),
    );
    try {
      await api.unpin(item.message.id);
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
              count={items.length}
              selected={filter === null}
              onPress={() => setChatFilter(null)}
            />
            {groups.map(({ chat, count }) => (
              <TabChip
                key={chat.id}
                label={chatTitle(chat, t("directChat"))}
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
                {t("importantEmptyHint")}
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
                ...(canUnpin(menuFor, user.id, user.permissions)
                  ? [
                      {
                        key: "remove",
                        testID: "important-remove",
                        label: t("importantRemove"),
                        icon: <PinOff size={20} color={theme.danger} />,
                        danger: true,
                        onPress: () => void remove(menuFor),
                      },
                    ]
                  : []),
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
