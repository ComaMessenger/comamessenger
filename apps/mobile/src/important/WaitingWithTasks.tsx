import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  SectionList,
  StyleSheet,
  View,
} from "react-native";
import { router } from "expo-router";
import { MessageCircleCheck, SquareCheck } from "lucide-react-native";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import {
  filterWaitingRows,
  grantsPermission,
  groupMyTasks,
  importantCounts,
  mergeTaskItems,
  myTaskGroupLabelKeys,
  newerTask,
  taskInboxModeLabelKeys,
  taskKeys,
  waitingFilterLabelKeys,
  waitingList,
  type MyTaskGroupKind,
  type MyTaskItem,
  type RequestInboxItem,
  type TaskInboxMode,
  type WaitingFilter,
  type WaitingInboxItem,
  type WaitingRow as Row,
} from "@comamessenger/core";
import { useTheme } from "@/lib/theme";
import { useMessenger } from "@/messenger/MessengerProvider";
import { useSignedIn } from "@/session/SessionProvider";
import { useChatMembers } from "@/chatinfo/queries";
import { chatTitle } from "@/chats/ChatRow";
import { Notice } from "@/ui/Notice";
import { TabChip } from "@/ui/TabChip";
import { Text } from "@/ui/Text";
import { Segmented } from "@/requests/parts";
import { TaskRow } from "@/tasks/TaskRow";
import { phoneInboxFeatures } from "./features";
import { WaitingRow, useInbox } from "./WaitingList";

/** One list of «Ждут вас», page by page. */
function useWaitingInbox(kind: "all" | "requests" | "tasks", enabled: boolean) {
  const { api, user } = useSignedIn();
  return useInfiniteQuery({
    queryKey: taskKeys.waiting(user.id, kind),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.waitingInbox({ kind, cursor: pageParam }),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    enabled,
  });
}

/** «На мне» or «Поставил(а) я», open or done in the last 7 days. */
function useMyTasks(
  role: "assigned" | "authored",
  state: "open" | "done",
  enabled: boolean,
) {
  const { api, user } = useSignedIn();
  return useInfiniteQuery({
    queryKey: taskKeys.mine(user.id, role, state),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.myTasks({ role, state, cursor: pageParam }),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    enabled,
  });
}

/** A waitingInbox task item in the shape of listMyTasks. */
function asMyTask(item: WaitingInboxItem): MyTaskItem | null {
  if (item.kind !== "task" || !item.message.task || !item.my_role) return null;
  return {
    message: item.message,
    author: item.author,
    chat: item.chat,
    my_role: item.my_role,
  };
}

type Section = {
  key: string;
  title: string | null;
  danger?: boolean;
  data: Row[];
};

/**
 * «Ждут вас» with tasks (decision 16): chips «Всё · Запросы · Задачи»,
 * requests and tasks on the reader in one order by due date, then
 * «Отвечено». «Задачи» has «На мне / Поставил(а) я» and the groups of
 * prototype E: «Просрочено · Сегодня · Позже · Без срока · Готово за 7
 * дней». A task row closes the task with its round check; a tap opens the
 * chat on its card.
 */
export function WaitingWithTasks({
  filters,
  onNotice,
}: {
  filters: WaitingFilter[];
  onNotice(text: string): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { user } = useSignedIn();
  const { store } = useMessenger();
  const features = useStore(store, (state) => state.features);
  const unread = useStore(store, (state) => state.unread);
  const viewers = useStore(store, (state) => state.requestViewers);
  const messages = useStore(store, (state) => state.messages);
  const chats = useStore(store, (state) => state.chats);
  const [filter, setFilter] = useState<WaitingFilter>("all");
  const [mode, setMode] = useState<TaskInboxMode>("assigned");
  const counts = importantCounts(unread, phoneInboxFeatures(features));
  const chipCounts: Record<WaitingFilter, number> = {
    all: counts.waiting,
    requests: Math.max(0, unread.requests_waiting_total ?? 0),
    tasks: Math.max(0, unread.tasks_mine_open_total ?? 0),
    polls: 0,
  };
  const tasksOnly = filter === "tasks";
  const assigned = mode === "assigned";
  const waiting = useWaitingInbox(
    filter === "requests" ? "requests" : tasksOnly ? "tasks" : "all",
    !tasksOnly || assigned,
  );
  const answered = useInbox("answered", !tasksOnly);
  const authoredOpen = useMyTasks("authored", "open", tasksOnly && !assigned);
  const done = useMyTasks(mode, "done", tasksOnly);

  // The feed may hold a fresher copy of a task (task.updated came meanwhile).
  const fresh = useCallback(
    (chatID: string, messageID: string) =>
      messages[chatID]?.find((message) => message.id === messageID)?.task,
    [messages],
  );
  const pageItems = useMemo(
    () => waiting.data?.pages.flatMap((page) => page.items) ?? [],
    [waiting.data],
  );
  const sections: Section[] = useMemo(() => {
    if (tasksOnly) {
      const open: MyTaskItem[] = assigned
        ? pageItems
            .map(asMyTask)
            .filter((item): item is MyTaskItem => item !== null)
        : (authoredOpen.data?.pages.flatMap((page) => page.items) ?? []);
      const closed = done.data?.pages.flatMap((page) => page.items) ?? [];
      const items = mergeTaskItems(open, closed).map((item) => {
        const task = newerTask(
          item.message.task,
          fresh(item.chat.id, item.message.id),
        );
        return task === item.message.task
          ? item
          : { ...item, message: { ...item.message, task } };
      });
      return groupMyTasks(items, new Date()).map((group) => ({
        key: group.kind,
        title: t("taskGroupCount", {
          group: t(myTaskGroupLabelKeys[group.kind as MyTaskGroupKind]),
          count: group.items.length,
        }),
        danger: group.kind === "overdue",
        data: group.items.map((item) => ({ kind: "task" as const, item })),
      }));
    }
    const answeredItems: RequestInboxItem[] =
      answered.data?.pages.flatMap((page) => page.items) ?? [];
    const list = waitingList(pageItems, answeredItems, user.id, {
      viewers,
      tasks: Object.fromEntries(
        pageItems.flatMap((item) => {
          const task = fresh(item.chat_id, item.message.id);
          return task ? [[item.message.id, task]] : [];
        }),
      ),
    });
    const rows = filterWaitingRows(list.waiting, filter).filter(
      (row) => row.kind !== "poll",
    );
    return [
      ...(rows.length ? [{ key: "waiting", title: null, data: rows }] : []),
      ...(list.answered.length
        ? [
            {
              key: "answered",
              title: t("importantAnswered"),
              data: list.answered.map((item) => ({
                kind: "request" as const,
                item,
              })),
            },
          ]
        : []),
    ];
  }, [
    answered.data,
    assigned,
    authoredOpen.data,
    done.data,
    filter,
    fresh,
    pageItems,
    t,
    tasksOnly,
    user.id,
    viewers,
  ]);

  const main = tasksOnly && !assigned ? authoredOpen : waiting;
  const loading = main.isPending && main.fetchStatus !== "idle";
  const refresh = () => {
    void main.refetch();
    if (tasksOnly) void done.refetch();
    else void answered.refetch();
  };
  const chatName = (chatID: string, fallback: string) =>
    chats[chatID]
      ? chatTitle(chats[chatID]!, t("directChat"))
      : fallback || t("directChat");

  const head = (
    <View style={styles.head}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        accessibilityRole="tablist"
        accessibilityLabel={t("importantFilters")}
        contentContainerStyle={styles.chips}
      >
        {filters
          .filter((id) => id !== "polls")
          .map((id) => (
            <TabChip
              key={id}
              testID={`waiting-filter-${id}`}
              label={t(waitingFilterLabelKeys[id])}
              count={chipCounts[id] > 0 ? chipCounts[id] : undefined}
              selected={filter === id}
              onPress={() => setFilter(id)}
            />
          ))}
      </ScrollView>
      {tasksOnly ? (
        <View style={styles.mode}>
          <Segmented<TaskInboxMode>
            testID="waiting-tasks-role"
            value={mode}
            options={(["assigned", "authored"] as const).map((id) => ({
              value: id,
              label: t(taskInboxModeLabelKeys[id]),
            }))}
            onChange={setMode}
          />
        </View>
      ) : null}
    </View>
  );

  return (
    <SectionList
      testID="important-waiting"
      sections={sections}
      keyExtractor={(row) => row.item.message.id}
      ListHeaderComponent={head}
      stickySectionHeadersEnabled={false}
      renderSectionHeader={({ section }) =>
        section.title ? (
          <Text
            weight="semibold"
            size={12}
            style={[
              styles.section,
              { color: section.danger ? theme.danger : theme.muted },
            ]}
          >
            {section.title.toLocaleUpperCase()}
          </Text>
        ) : null
      }
      renderItem={({ item: row, index, section }) =>
        row.kind === "request" ? (
          <WaitingRow
            item={row.item}
            testID={`waiting-row-${section.key}-${index}`}
            onNotice={onNotice}
          />
        ) : row.kind === "task" ? (
          <InboxTask
            item={row.item}
            testID={`waiting-task-${section.key}-${index}`}
            chatName={chatName(row.item.chat.id, row.item.chat.display_name)}
            onNotice={onNotice}
          />
        ) : null
      }
      onEndReached={() => {
        if (main.hasNextPage && !main.isFetchingNextPage)
          void main.fetchNextPage();
        else if (tasksOnly) {
          if (done.hasNextPage && !done.isFetchingNextPage)
            void done.fetchNextPage();
        } else if (answered.hasNextPage && !answered.isFetchingNextPage)
          void answered.fetchNextPage();
      }}
      refreshControl={
        <RefreshControl
          refreshing={main.isRefetching}
          onRefresh={refresh}
          tintColor={theme.muted}
        />
      }
      ListEmptyComponent={
        loading ? (
          <ActivityIndicator style={styles.loader} color={theme.muted} />
        ) : main.isError ? (
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
              {tasksOnly ? (
                <SquareCheck size={26} color={theme.muted} />
              ) : (
                <MessageCircleCheck size={26} color={theme.muted} />
              )}
            </View>
            <Text weight="semibold" size={17} style={styles.center}>
              {tasksOnly
                ? assigned
                  ? t("taskMineEmpty")
                  : t("taskAuthoredEmpty")
                : t("importantWaitingEmpty")}
            </Text>
            <Text tone="muted" size={15} style={styles.center}>
              {tasksOnly
                ? assigned
                  ? t("taskMineEmptyHint")
                  : t("taskAuthoredEmptyHint")
                : t("importantWaitingEmptyHintTasks")}
            </Text>
          </View>
        )
      }
    />
  );
}

/** A task of «Ждут вас»: the row with the reader's role in its chat. */
function InboxTask({
  item,
  chatName,
  testID,
  onNotice,
}: {
  item: MyTaskItem;
  chatName: string;
  testID?: string;
  onNotice(text: string): void;
}) {
  const { user } = useSignedIn();
  const { store } = useMessenger();
  const chatRole = useStore(store, (state) => state.chats[item.chat.id]?.role);
  // Names of the responsible people of «Поставил(а) я».
  const { members } = useChatMembers(item.chat.id);
  const message = item.message as typeof item.message & {
    task: NonNullable<typeof item.message.task>;
  };
  return (
    <TaskRow
      testID={testID}
      message={message}
      viewer={{
        actorID: user.id,
        chatRole: chatRole ?? (item.my_role ? "member" : null),
        moderator: grantsPermission(
          user.role,
          user.permissions ?? [],
          "chats.moderate",
        ),
      }}
      members={members}
      people={[item.author]}
      chatName={chatName}
      onNotice={onNotice}
      onOpen={() =>
        router.push(`/chat/${item.chat.id}?message=${item.message.id}`)
      }
    />
  );
}

const styles = StyleSheet.create({
  head: { paddingTop: 2, paddingBottom: 4 },
  chips: { gap: 6, paddingHorizontal: 14, paddingBottom: 8 },
  mode: { paddingHorizontal: 14, paddingBottom: 6 },
  // Prototype `.sect`: 12px, 600, uppercase, padding 14px 16px 8px.
  section: {
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 8,
    letterSpacing: 0.5,
  },
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
