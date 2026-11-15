import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Bell, Clock3 } from "lucide-react-native";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import {
  formatRequestDue,
  messagePlainText,
  requestAnswerNote,
  requestAnswerTabs,
  requestAudienceText,
  requestKeys,
  requestLimits,
  requestOptionLabels,
  requestRemindState,
  type RequestAnswer,
  type RequestAnswerFilter,
} from "@comamessenger/core";
import { spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { useMessenger } from "@/messenger/MessengerProvider";
import { useSignedIn } from "@/session/SessionProvider";
import { useChatMembers } from "@/chatinfo/queries";
import { Avatar } from "@/ui/Avatar";
import { Notice } from "@/ui/Notice";
import { ScreenHeader } from "@/ui/ScreenHeader";
import { TabChip } from "@/ui/TabChip";
import { useAwayAvailable } from "@/status/useAway";
import { AwayNote } from "@/status/AwayNote";
import { Text } from "@/ui/Text";
import { useClock, useNow } from "@/scheduled/clock";
import { formatTime } from "@/scheduled/format";
import { calendarLocale } from "./locale";
import { WideButton } from "./parts";
import { useRequestActions } from "./useRequestActions";

/**
 * «Ответы» of a request, for its author and chat admins: tabs «Нет ответа»
 * and one per button with counts, rows with comments and «прочитал(а), не
 * ответил(а)» / «не открывал(а) чат», «Напомнить не ответившим · k» at the
 * bottom and «Закрыть» in the header (prototype «Запрос», phone C).
 */
export function RequestAnswersScreen({
  chatID,
  messageID,
}: {
  chatID: string;
  messageID: string;
}) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const clock = useClock();
  const { api, user } = useSignedIn();
  const { store } = useMessenger();
  const { members } = useChatMembers(chatID);
  const now = useNow(60_000);
  const locale = calendarLocale(i18n.language);
  const [notice, setNotice] = useState<string | null>(null);
  const actions = useRequestActions(setNotice);
  const [filter, setFilter] = useState<RequestAnswerFilter | null>(null);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 2200);
    return () => clearTimeout(timer);
  }, [notice]);

  // The request and the reader's rights, kept in the store with the feed.
  const state = useQuery({
    queryKey: requestKeys.state(user.id, messageID),
    queryFn: async () => {
      const value = await api.messageRequest(messageID);
      store.getState().setRequestState(messageID, value, chatID);
      return value;
    },
  });
  const loaded = useStore(store, (s) =>
    (s.messages[chatID] ?? []).find((message) => message.id === messageID),
  );
  const viewerEntry = useStore(store, (s) => s.requestViewers[messageID]);
  // The text: from the feed, or read with its neighbours when not loaded.
  const context = useQuery({
    queryKey: ["request-message", messageID],
    queryFn: () => api.messageContext(messageID, 3),
    enabled: !loaded,
    staleTime: 60_000,
  });
  const message =
    loaded ??
    context.data?.messages.find((item) => item.id === messageID) ??
    null;
  const request = loaded?.request ?? state.data?.request ?? null;
  const viewer = viewerEntry?.viewer ?? state.data?.viewer ?? null;
  const options = request ? requestOptionLabels(request, t) : [];

  const current: RequestAnswerFilter = filter ?? "waiting";
  const answers = useInfiniteQuery({
    queryKey: requestKeys.answers(user.id, messageID, current),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.requestAnswers(messageID, { filter: current, cursor: pageParam }),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    enabled: Boolean(viewer?.can_view_answers),
  });
  const counts = answers.data?.pages[0]?.counts;
  const tabs = useMemo(
    () => (counts ? requestAnswerTabs(counts, options) : []),
    [counts, options],
  );
  // Nobody is left to answer: open on the first button instead.
  useEffect(() => {
    if (filter === null && counts && counts.waiting === 0 && options.length)
      setFilter("option:0");
  }, [counts, filter, options.length]);
  const rows = useMemo(
    () => answers.data?.pages.flatMap((page) => page.items) ?? [],
    [answers.data],
  );

  const remind = request
    ? requestRemindState(request, viewer, now)
    : { kind: "hidden" as const };
  const open = request?.status === "open";
  const subtitle = request
    ? `${t("requestKind")} · ${requestAudienceText(request.audience, locale)}`
    : t("requestKind");

  function confirmClose() {
    Alert.alert(t("requestCloseTitle"), t("requestCloseHint"), [
      { text: t("cancel"), style: "cancel" },
      {
        text: t("requestClose"),
        onPress: () => void actions.close(messageID, chatID),
      },
    ]);
  }

  // «Отсутствую» (phase 6.7 decision 6): an away recipient is marked.
  const awayOn = useAwayAvailable();
  const memberOf = (actorID: string) =>
    members.find((member) => member.actor_id === actorID);

  function note(item: RequestAnswer) {
    switch (requestAnswerNote(item)) {
      case "comment":
        return { text: `«${item.comment}»`, tone: "default" as const };
      case "readNotAnswered":
        return { text: t("requestReadNotAnswered"), tone: "warning" as const };
      case "notOpened":
        return { text: t("requestNotOpened"), tone: "muted" as const };
      case "left":
        return { text: t("requestLeftChat"), tone: "muted" as const };
      case "answered":
        return {
          text: item.late ? t("requestLate") : t("requestAnswered"),
          tone: "muted" as const,
        };
    }
  }

  return (
    <SafeAreaView
      testID="request-answers"
      edges={["bottom"]}
      style={[styles.screen, { backgroundColor: theme.surface }]}
    >
      <ScreenHeader
        backTestID="request-answers-back"
        title={t("requestAnswersTitle")}
        subtitle={subtitle}
        trailing={
          viewer?.can_close && open ? (
            <Pressable
              testID="request-answers-close"
              accessibilityRole="button"
              hitSlop={10}
              onPress={confirmClose}
              style={styles.headerAction}
            >
              <Text tone="primary" weight="semibold" size={15}>
                {t("requestClose")}
              </Text>
            </Pressable>
          ) : request && !open ? (
            <Text
              tone="muted"
              weight="semibold"
              size={13}
              style={styles.headerAction}
            >
              {t("requestClosed")}
            </Text>
          ) : undefined
        }
      />
      {state.isError && !request ? (
        <View style={styles.state}>
          <Notice
            title={t("loadFailed")}
            actionLabel={t("retry")}
            onAction={() => void state.refetch()}
          />
        </View>
      ) : !request ? (
        <ActivityIndicator style={styles.loader} color={theme.muted} />
      ) : (
        <FlatList
          data={viewer?.can_view_answers ? rows : []}
          keyExtractor={(item) => item.actor_id}
          onEndReached={() => {
            if (answers.hasNextPage && !answers.isFetchingNextPage)
              void answers.fetchNextPage();
          }}
          ListHeaderComponent={
            <>
              {/* Prototype `.ackq`: the question on the canvas grey. */}
              <View
                style={[
                  styles.question,
                  { backgroundColor: theme.canvas, borderColor: theme.border },
                ]}
              >
                <Text tone="muted" size={12}>
                  {[
                    message?.actor_id === user.id
                      ? t("previewYou")
                      : (memberOf(message?.actor_id ?? "")?.display_name ?? ""),
                    request.due_at
                      ? formatRequestDue(new Date(request.due_at), now, locale)
                      : t("requestDueNone"),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </Text>
                <Text size={14}>
                  {message ? messagePlainText(message.body) : "…"}
                </Text>
              </View>
              {tabs.length > 0 ? (
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.tabs}
                  accessibilityRole="tablist"
                >
                  {tabs.map((tab) => (
                    <TabChip
                      key={tab.filter}
                      testID={`request-tab-${tab.filter.replace(":", "-")}`}
                      label={tab.label ?? t("requestNoAnswer")}
                      count={tab.count}
                      selected={tab.filter === current}
                      onPress={() => setFilter(tab.filter)}
                    />
                  ))}
                </ScrollView>
              ) : null}
            </>
          }
          renderItem={({ item }) => {
            const member = memberOf(item.actor_id);
            const line = note(item);
            return (
              <View style={styles.row} testID={`request-answer-row`}>
                <Avatar
                  name={member?.display_name ?? ""}
                  seed={item.actor_id}
                  size={36}
                  actorID={item.actor_id}
                  avatarVersion={member?.avatar_version}
                />
                <View style={styles.rowText}>
                  <Text weight="semibold" size={15} numberOfLines={1}>
                    {member?.display_name ?? t("participant")}
                  </Text>
                  {member && awayOn ? (
                    <AwayNote member={member} />
                  ) : null}
                  <Text
                    size={13.5}
                    numberOfLines={3}
                    tone={line.tone === "warning" ? "default" : line.tone}
                    style={
                      line.tone === "warning"
                        ? { color: theme.warning }
                        : undefined
                    }
                  >
                    {line.text}
                  </Text>
                </View>
                {item.answered_at ? (
                  <Text tone="muted" size={12}>
                    {formatTime(new Date(item.answered_at), clock)}
                  </Text>
                ) : null}
              </View>
            );
          }}
          ListEmptyComponent={
            answers.isPending && viewer?.can_view_answers ? (
              <ActivityIndicator style={styles.loader} color={theme.muted} />
            ) : (
              <Text tone="muted" size={14} style={styles.empty}>
                {viewer?.can_view_answers
                  ? t("requestAnswersEmpty")
                  : t("requestAnswersHidden")}
              </Text>
            )
          }
        />
      )}
      {request &&
      open &&
      (remind.kind !== "hidden" ||
        (request.auto_remind_at &&
          Date.parse(request.auto_remind_at) > now.getTime())) ? (
        <View style={[styles.foot, { borderTopColor: theme.border }]}>
          {remind.kind === "ready" ? (
            <WideButton
              testID="request-answers-remind"
              label={t("requestRemindAll", { count: remind.count })}
              icon={<Bell size={18} color={theme.onPrimary} />}
              onPress={() => void actions.remind(messageID, chatID)}
            />
          ) : remind.kind === "cooldown" ? (
            <WideButton
              testID="request-answers-reminded"
              variant="secondary"
              disabled
              label={t("requestRemindedAt", {
                time: formatTime(
                  new Date(
                    remind.until.getTime() - requestLimits.remindIntervalMs,
                  ),
                  clock,
                ),
                until: formatTime(remind.until, clock),
              })}
              onPress={() => undefined}
            />
          ) : remind.kind === "allAnswered" ? (
            <WideButton
              variant="secondary"
              disabled
              label={t("requestAllAnswered")}
              onPress={() => undefined}
            />
          ) : null}
          {request.auto_remind_at &&
          Date.parse(request.auto_remind_at) > now.getTime() ? (
            <View style={styles.auto}>
              <Clock3 size={13} color={theme.muted} />
              <Text tone="muted" size={13}>
                {t("requestAutoRemindAt", {
                  when: formatRequestDue(
                    new Date(request.auto_remind_at),
                    now,
                    locale,
                  ),
                })}
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}
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
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  headerAction: { paddingHorizontal: 12 },
  state: { padding: 20 },
  loader: { marginTop: 40 },
  question: {
    marginHorizontal: 14,
    marginTop: 12,
    marginBottom: 4,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 14,
    borderWidth: 1,
    gap: 2,
  },
  tabs: { gap: 6, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 6 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  rowText: { flex: 1, minWidth: 0 },
  empty: { textAlign: "center", padding: 30 },
  foot: {
    paddingHorizontal: 14,
    paddingTop: 14,
    paddingBottom: spacing[2],
    borderTopWidth: 1,
    gap: 8,
  },
  auto: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
  },
  notice: {
    position: "absolute",
    alignSelf: "center",
    bottom: 110,
    borderRadius: 18,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
    maxWidth: "90%",
  },
});
