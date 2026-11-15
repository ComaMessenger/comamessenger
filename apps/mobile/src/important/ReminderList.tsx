import { memo, useCallback, useMemo, useState, type ReactElement } from "react";
import {
  ActivityIndicator,
  RefreshControl,
  SectionList,
  StyleSheet,
  View,
} from "react-native";
import { router } from "expo-router";
import { Bell, StickyNote } from "lucide-react-native";
import {
  useInfiniteQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import {
  groupReminders,
  messagePlainText,
  reminderHref,
  reminderInput,
  reminderKeys,
  reminderMissed,
  withReminder,
  type Reminder,
  type ReminderIdEntry,
  type ReminderPage,
} from "@comamessenger/core";
import { useTheme } from "@/lib/theme";
import { useMessenger } from "@/messenger/MessengerProvider";
import { useSignedIn } from "@/session/SessionProvider";
import { chatTitle } from "@/chats/ChatRow";
import { Notice } from "@/ui/Notice";
import { Text } from "@/ui/Text";
import { useClock, useNow } from "@/scheduled/clock";
import { formatSectionDay, formatTime } from "@/scheduled/format";
import { SmallButton } from "@/requests/parts";
import { ReminderSheet } from "@/reminders/ReminderSheet";
import { useReminderErrorText } from "@/reminders/useReminders";

function useReminderPages(state: "pending" | "fired") {
  const { api, user } = useSignedIn();
  return useInfiniteQuery({
    queryKey: reminderKeys.list(user.id, state),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.reminders({ state, cursor: pageParam }),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });
}

type Section = { key: string; title: string; data: Reminder[] };

/**
 * «Важные → Напоминания»: fired reminders first («Сработали»), then the
 * pending ones by day («Сегодня», «Завтра», days of the week, «Позже»).
 * Each has its note and «Перенести», «Открыть», «Готово». Only the reader
 * sees them.
 */
export function ReminderList({
  header,
  onNotice,
}: {
  header?: ReactElement;
  onNotice(text: string): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const clock = useClock();
  const { api, user } = useSignedIn();
  const queryClient = useQueryClient();
  const errorText = useReminderErrorText();
  const now = useNow(60_000);
  const pending = useReminderPages("pending");
  const fired = useReminderPages("fired");
  const [moving, setMoving] = useState<Reminder | null>(null);
  const [busy, setBusy] = useState(false);

  const items = useMemo(
    () => [
      ...(fired.data?.pages.flatMap((page) => page.items) ?? []),
      ...(pending.data?.pages.flatMap((page) => page.items) ?? []),
    ],
    [fired.data, pending.data],
  );
  const groups = useMemo(() => groupReminders(items, now), [items, now]);
  const sections: Section[] = [
    ...(groups.fired.length
      ? [{ key: "fired", title: t("remindersFired"), data: groups.fired }]
      : []),
    ...groups.days.map((group) => ({
      key: group.key,
      title:
        group.kind === "later"
          ? t("remindersLater")
          : formatSectionDay(group.day, now, clock, {
              today: t("scheduledToday"),
              tomorrow: t("scheduledTomorrow"),
            }),
      data: group.items,
    })),
  ];

  const refresh = useCallback(() => {
    void pending.refetch();
    void fired.refetch();
  }, [fired, pending]);

  /** Drops a reminder from both cached lists and the chat's bells. */
  function forget(item: Reminder) {
    for (const state of ["pending", "fired"] as const)
      queryClient.setQueryData<InfiniteData<ReminderPage>>(
        reminderKeys.list(user.id, state),
        (data) =>
          data && {
            ...data,
            pages: data.pages.map((page) => ({
              ...page,
              items: page.items.filter((entry) => entry.id !== item.id),
            })),
          },
      );
    if (item.message_id)
      queryClient.setQueryData<ReminderIdEntry[]>(
        reminderKeys.ids(user.id, item.chat_id),
        (entries) => withReminder(entries, item.message_id!, null),
      );
  }

  async function done(item: Reminder) {
    forget(item);
    try {
      if (item.message_id) await api.deleteMessageReminder(item.message_id);
      else await api.deleteReminder(item.id);
      onNotice(t("reminderRemovedNotice"));
    } catch (error) {
      onNotice(errorText(error));
      refresh();
    }
  }

  async function move(item: Reminder, at: Date, note: string) {
    setBusy(true);
    try {
      const input = reminderInput(at, note);
      const saved = item.message_id
        ? await api.setMessageReminder(item.message_id, input)
        : await api.updateReminder(item.id, input);
      if (saved.message_id)
        queryClient.setQueryData<ReminderIdEntry[]>(
          reminderKeys.ids(user.id, saved.chat_id),
          (entries) =>
            withReminder(entries, saved.message_id!, saved.remind_at),
        );
      setMoving(null);
      refresh();
      onNotice(t("reminderMovedNotice"));
    } catch (error) {
      onNotice(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  const loading =
    (pending.isPending && pending.fetchStatus !== "idle") ||
    (fired.isPending && fired.fetchStatus !== "idle");
  return (
    <>
      <SectionList
        testID="important-reminders"
        sections={sections}
        keyExtractor={(item) => item.id}
        ListHeaderComponent={header}
        stickySectionHeadersEnabled={false}
        renderSectionHeader={({ section }) => (
          <Text tone="muted" weight="semibold" size={12} style={styles.section}>
            {section.title.toLocaleUpperCase()}
          </Text>
        )}
        renderItem={({ item, index }) => (
          <ReminderItem
            item={item}
            testID={`reminder-row-${index}`}
            onMove={setMoving}
            onDone={(value) => void done(value)}
          />
        )}
        onEndReached={() => {
          if (fired.hasNextPage && !fired.isFetchingNextPage)
            void fired.fetchNextPage();
          else if (pending.hasNextPage && !pending.isFetchingNextPage)
            void pending.fetchNextPage();
        }}
        refreshControl={
          <RefreshControl
            refreshing={pending.isRefetching || fired.isRefetching}
            onRefresh={refresh}
            tintColor={theme.muted}
          />
        }
        contentContainerStyle={styles.content}
        style={{ backgroundColor: theme.canvas }}
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator style={styles.loader} color={theme.muted} />
          ) : pending.isError || fired.isError ? (
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
                <Bell size={26} color={theme.muted} />
              </View>
              <Text weight="semibold" size={17} style={styles.center}>
                {t("remindersEmpty")}
              </Text>
              <Text tone="muted" size={15} style={styles.center}>
                {t("remindersEmptyHint")}
              </Text>
            </View>
          )
        }
      />
      <ReminderSheet
        visible={moving !== null}
        title={t("reminderMoveTitle")}
        initial={
          moving ? { at: new Date(moving.remind_at), note: moving.note } : null
        }
        pending={busy}
        onConfirm={(at, note) => moving && void move(moving, at, note)}
        onClose={() => setMoving(null)}
      />
    </>
  );
}

/** One reminder (prototype `.sitem`). */
const ReminderItem = memo(function ReminderItem({
  item,
  testID,
  onMove,
  onDone,
}: {
  item: Reminder;
  testID?: string;
  onMove(item: Reminder): void;
  onDone(item: Reminder): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const clock = useClock();
  const { store } = useMessenger();
  const localChat = useStore(store, (state) => state.chats[item.chat_id]);
  const linked = item.message;
  const chatName = localChat
    ? chatTitle(localChat, t("directChat"))
    : (linked?.chat.display_name ?? "");
  const missed = reminderMissed(item);
  const at = new Date(item.remind_at);
  const text = linked ? messagePlainText(linked.message.body).trim() : "";
  const author = linked?.author.display_name.split(" ")[0] ?? "";
  return (
    <View
      testID={testID}
      style={[
        styles.item,
        { backgroundColor: theme.surface, borderColor: theme.border },
      ]}
    >
      <View style={styles.when}>
        <Bell size={14} color={missed ? theme.warning : theme.primary} />
        <Text
          weight="semibold"
          size={12.5}
          numberOfLines={1}
          style={{ color: missed ? theme.warning : theme.primary }}
        >
          {missed
            ? t("reminderMissed", { time: formatTime(at, clock) })
            : formatTime(at, clock)}
        </Text>
        <Text
          tone="muted"
          weight="medium"
          size={12.5}
          numberOfLines={1}
          style={styles.chatName}
        >
          {chatName}
        </Text>
      </View>
      {item.access === "available" && text ? (
        <Text size={14.5} numberOfLines={4} style={styles.text}>
          <Text size={14.5} weight="semibold">
            {`${author}: `}
          </Text>
          {text}
        </Text>
      ) : (
        <Text tone="muted" size={14} style={styles.text}>
          {item.access === "deleted" || !item.message_id
            ? t("reminderMessageDeleted")
            : t("reminderNoAccess")}
        </Text>
      )}
      {item.note ? (
        <View style={styles.note}>
          <StickyNote size={14} color={theme.muted} />
          <Text tone="muted" size={13} style={styles.grow}>
            {item.note}
          </Text>
        </View>
      ) : null}
      <View style={styles.actions}>
        <SmallButton
          testID="reminder-move"
          label={t("reminderMove")}
          onPress={() => onMove(item)}
        />
        {item.access === "available" && item.message_id ? (
          <SmallButton
            testID="reminder-open"
            label={t("reminderOpen")}
            onPress={() => router.push(reminderHref(item) as never)}
          />
        ) : null}
        <View style={styles.grow} />
        <SmallButton
          testID="reminder-done"
          label={t("reminderDone")}
          variant="primary"
          onPress={() => onDone(item)}
        />
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  content: { paddingBottom: 16, flexGrow: 1 },
  // Prototype `.sect`: 12px 600 uppercase, padding 14px 16px 8px.
  section: {
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 8,
    letterSpacing: 0.5,
  },
  // Prototype `.sitem`: radius 16, padding 11px 12px, margin 0 12px 10px.
  item: {
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 11,
    marginHorizontal: 12,
    marginBottom: 10,
  },
  when: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    marginBottom: 4,
  },
  chatName: { marginLeft: "auto", flexShrink: 1 },
  text: { marginBottom: 9 },
  note: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    marginTop: -4,
    marginBottom: 9,
  },
  actions: { flexDirection: "row", gap: 6, alignItems: "center" },
  grow: { flex: 1 },
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
