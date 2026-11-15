import { memo, useCallback, useMemo, type ReactElement } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  View,
} from "react-native";
import { router } from "expo-router";
import { MessageCircleCheck } from "lucide-react-native";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import {
  formatListTime,
  formatRequestDue,
  messagePlainText,
  requestKeys,
  waitingSections,
  type RequestInboxItem,
} from "@comamessenger/core";
import { useTheme } from "@/lib/theme";
import { useMessenger } from "@/messenger/MessengerProvider";
import { useSignedIn } from "@/session/SessionProvider";
import { ChatAvatar } from "@/chats/ChatAvatar";
import { chatTitle } from "@/chats/ChatRow";
import { Notice } from "@/ui/Notice";
import { Text } from "@/ui/Text";
import { useNow } from "@/scheduled/clock";
import { calendarLocale } from "@/requests/locale";
import { RequestCard } from "@/requests/RequestCard";

function useInbox(state: "waiting" | "answered") {
  const { api, user } = useSignedIn();
  return useInfiniteQuery({
    queryKey: requestKeys.inbox(user.id, state),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.requestInbox({ state, cursor: pageParam }),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });
}

/**
 * «Важные → Ждут вас»: requests waiting for the reader's answer, with the
 * buttons right in the card (soonest due date first), then «Отвечено» —
 * open requests the reader already answered, to change the answer.
 */
export function WaitingList({
  header,
  onNotice,
}: {
  header?: ReactElement;
  onNotice(text: string): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { store } = useMessenger();
  const viewers = useStore(store, (state) => state.requestViewers);
  const waiting = useInbox("waiting");
  const answered = useInbox("answered");
  const sections = useMemo(
    () =>
      waitingSections(
        waiting.data?.pages.flatMap((page) => page.items) ?? [],
        answered.data?.pages.flatMap((page) => page.items) ?? [],
        viewers,
      ),
    [answered.data, viewers, waiting.data],
  );
  const data = [
    ...(sections.waiting.length
      ? [{ key: "waiting", title: null, data: sections.waiting }]
      : []),
    ...(sections.answered.length
      ? [
          {
            key: "answered",
            title: t("importantAnswered"),
            data: sections.answered,
          },
        ]
      : []),
  ];
  const loading = waiting.isPending && waiting.fetchStatus !== "idle";
  const refresh = useCallback(() => {
    void waiting.refetch();
    void answered.refetch();
  }, [answered, waiting]);

  return (
    <SectionList
      testID="important-waiting"
      sections={data}
      keyExtractor={(item) => item.message.id}
      ListHeaderComponent={header}
      stickySectionHeadersEnabled={false}
      renderSectionHeader={({ section }) =>
        section.title ? (
          <Text tone="muted" weight="semibold" size={12} style={styles.section}>
            {section.title.toLocaleUpperCase()}
          </Text>
        ) : null
      }
      renderItem={({ item, index }) => (
        <WaitingRow
          item={item}
          testID={`waiting-row-${index}`}
          onNotice={onNotice}
        />
      )}
      onEndReached={() => {
        if (waiting.hasNextPage && !waiting.isFetchingNextPage)
          void waiting.fetchNextPage();
        else if (answered.hasNextPage && !answered.isFetchingNextPage)
          void answered.fetchNextPage();
      }}
      refreshControl={
        <RefreshControl
          refreshing={waiting.isRefetching}
          onRefresh={refresh}
          tintColor={theme.muted}
        />
      }
      ListEmptyComponent={
        loading ? (
          <ActivityIndicator style={styles.loader} color={theme.muted} />
        ) : waiting.isError ? (
          <View style={styles.state}>
            <Notice
              title={t("importantLoadFailed")}
              actionLabel={t("retry")}
              onAction={refresh}
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
              <MessageCircleCheck size={26} color={theme.muted} />
            </View>
            <Text weight="semibold" size={17} style={styles.center}>
              {t("importantWaitingEmpty")}
            </Text>
            <Text tone="muted" size={15} style={styles.center}>
              {t("importantWaitingHint")}
            </Text>
          </View>
        )
      }
    />
  );
}

/** One request in «Ждут вас» (prototype `.imp` with the request buttons). */
const WaitingRow = memo(function WaitingRow({
  item,
  testID,
  onNotice,
}: {
  item: RequestInboxItem;
  testID?: string;
  onNotice(text: string): void;
}) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const { store } = useMessenger();
  const now = useNow(60_000);
  const localChat = useStore(store, (state) => state.chats[item.chat_id]);
  const chatName = localChat
    ? chatTitle(localChat, t("directChat"))
    : item.chat.display_name || t("directChat");
  const due = item.request.due_at
    ? t("requestAnswerBy", {
        when: formatRequestDue(
          new Date(item.request.due_at),
          now,
          calendarLocale(i18n.language),
        ),
      })
    : null;
  const message = { ...item.message, request: item.request };
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityHint={t("importantOpen")}
      onPress={() =>
        router.push(`/chat/${item.chat_id}?message=${item.message.id}`)
      }
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: pressed ? theme.surfaceSelected : theme.surface,
          borderBottomColor: theme.border,
        },
      ]}
    >
      <ChatAvatar
        name={item.author.display_name}
        seed={item.author.actor_id}
        size={36}
        shape="circle"
        actorID={item.author.actor_id}
        avatarVersion={item.author.avatar_version}
      />
      <View style={styles.body}>
        <View style={styles.line}>
          <Text weight="semibold" size={14.5} style={styles.grow}>
            {t("requestFrom", { name: item.author.display_name })}
          </Text>
          <Text tone="muted" size={12}>
            {formatListTime(
              item.message.created_at,
              i18n.language,
              t("yesterday"),
            )}
          </Text>
        </View>
        <Text weight="medium" size={12.5} tone="primary" style={styles.chat}>
          {[chatName, due].filter(Boolean).join(" · ")}
        </Text>
        <Text size={14.5} numberOfLines={3}>
          {messagePlainText(item.message.body)}
        </Text>
        <RequestCard
          message={message}
          part="body"
          fallbackViewer={item.viewer}
          compact
          onNotice={onNotice}
        />
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  section: {
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 8,
    letterSpacing: 0.5,
  },
  card: {
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderBottomWidth: 1,
  },
  body: { flex: 1, minWidth: 0 },
  line: { flexDirection: "row", alignItems: "baseline", gap: 6 },
  grow: { flex: 1 },
  chat: { marginBottom: 3 },
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
