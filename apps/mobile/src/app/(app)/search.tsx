import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ChevronLeft, FileText, Search } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { formatListTime, type SearchResult } from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { useMessenger } from "@/messenger/MessengerProvider";
import { useSignedIn } from "@/session/SessionProvider";
import { useTheme } from "@/lib/theme";
import { chatTitle } from "@/chats/ChatRow";
import { Notice } from "@/ui/Notice";
import { Text, fonts } from "@/ui/Text";

type Kind = "all" | "message" | "file";

function Highlight({ text, query }: { text: string; query: string }) {
  const needle = query.trim().toLocaleLowerCase();
  const index = needle ? text.toLocaleLowerCase().indexOf(needle) : -1;
  if (index < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, index)}
      <Text size={15} weight="semibold">
        {text.slice(index, index + needle.length)}
      </Text>
      {text.slice(index + needle.length)}
    </>
  );
}

export default function SearchScreen() {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const { api } = useSignedIn();
  const { store } = useMessenger();
  const chats = useStore(store, (state) => state.chats);
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<Kind>("all");

  useEffect(() => {
    const timer = setTimeout(() => setQuery(input.trim()), 300);
    return () => clearTimeout(timer);
  }, [input]);

  const search = useInfiniteQuery({
    queryKey: ["search", query, kind],
    queryFn: ({ pageParam }) =>
      api.search({ q: query, type: kind, cursor: pageParam, limit: 30 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    enabled: query.length >= 2,
  });
  const results = useMemo(
    () => search.data?.pages.flatMap((page) => page.results) ?? [],
    [search.data],
  );

  function open(result: SearchResult) {
    router.push(
      result.thread_root_id
        ? `/chat/${result.chat_id}/thread/${result.thread_root_id}`
        : `/chat/${result.chat_id}?message=${result.message_id}`,
    );
  }

  const kinds: { value: Kind; label: string }[] = [
    { value: "all", label: t("filterAll") },
    { value: "message", label: t("messagesTab") },
    { value: "file", label: t("filesTab") },
  ];

  return (
    <SafeAreaView edges={["top"]} style={styles.screen}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("back")}
          hitSlop={12}
          onPress={() => router.back()}
        >
          <ChevronLeft size={28} color={theme.primary} />
        </Pressable>
        <View style={[styles.input, { backgroundColor: theme.sidebar }]}>
          <Search size={20} color={theme.subtle} />
          <TextInput
            testID="search-input"
            value={input}
            onChangeText={setInput}
            autoFocus
            placeholder={t("searchPlaceholder")}
            placeholderTextColor={theme.subtle}
            accessibilityLabel={t("search")}
            returnKeyType="search"
            clearButtonMode="while-editing"
            style={[styles.field, { color: theme.foreground }]}
          />
        </View>
      </View>
      <View style={styles.kinds}>
        {kinds.map((item) => {
          const selected = item.value === kind;
          return (
            <Pressable
              key={item.value}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              onPress={() => setKind(item.value)}
              style={[
                styles.kind,
                { backgroundColor: selected ? theme.primary : theme.sidebar },
              ]}
            >
              <Text
                weight="medium"
                size={15}
                style={{ color: selected ? theme.onPrimary : theme.foreground }}
              >
                {item.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <FlatList
        data={results}
        keyExtractor={(item) =>
          `${item.kind}:${item.message_id}:${item.file_id ?? ""}`
        }
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        onEndReached={() => {
          if (search.hasNextPage && !search.isFetchingNextPage)
            void search.fetchNextPage();
        }}
        renderItem={({ item }) => {
          const chat = chats[item.chat_id];
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
                <Text tone="subtle" size={13}>
                  {formatListTime(
                    item.created_at,
                    i18n.language,
                    t("yesterday"),
                  )}
                </Text>
              </View>
              {item.kind === "file" && (
                <View style={styles.line}>
                  <FileText size={16} color={theme.primary} />
                  <Text
                    size={15}
                    weight="medium"
                    numberOfLines={1}
                    style={styles.grow}
                  >
                    {item.file_name}
                  </Text>
                </View>
              )}
              <Text
                size={15}
                tone={item.kind === "file" ? "muted" : "default"}
                numberOfLines={3}
              >
                <Highlight text={item.snippet} query={query} />
              </Text>
            </Pressable>
          );
        }}
        ListEmptyComponent={
          query.length < 2 ? (
            <Text tone="muted" size={15} style={styles.state}>
              {t("searchHint")}
            </Text>
          ) : search.isPending ? (
            <ActivityIndicator style={styles.loader} color={theme.muted} />
          ) : search.isError ? (
            <View style={styles.state}>
              <Notice
                title={t("searchFailed")}
                actionLabel={t("retry")}
                onAction={() => void search.refetch()}
              />
            </View>
          ) : (
            <Text tone="muted" size={15} style={styles.state}>
              {t("searchEmpty")}
            </Text>
          )
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
    gap: spacing[2],
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
  },
  input: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[2],
    height: 44,
    borderRadius: radius.lg,
    paddingHorizontal: spacing[3],
  },
  field: { flex: 1, fontFamily: fonts.regular, fontSize: 17 },
  kinds: {
    flexDirection: "row",
    gap: spacing[2],
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[2],
  },
  kind: {
    height: 34,
    paddingHorizontal: spacing[4],
    borderRadius: radius.full,
    justifyContent: "center",
  },
  row: {
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    gap: spacing[1],
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  line: { flexDirection: "row", alignItems: "center", gap: spacing[2] },
  grow: { flex: 1 },
  loader: { marginTop: spacing[10] },
  state: { padding: spacing[5] },
});
