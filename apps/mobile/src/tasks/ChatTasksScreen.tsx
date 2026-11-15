import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { hasTask, isTaskOnMe, taskKeys } from "@comamessenger/core";
import { useTheme } from "@/lib/theme";
import { useSignedIn } from "@/session/SessionProvider";
import { useChatMembers } from "@/chatinfo/queries";
import { Notice } from "@/ui/Notice";
import { ScreenHeader } from "@/ui/ScreenHeader";
import { TabChip } from "@/ui/TabChip";
import { Text } from "@/ui/Text";
import { useTaskViewer } from "./format";
import { TaskRow, type TaskRowMessage } from "./TaskRow";

type ListState = "open" | "done" | "canceled";

/**
 * «Все задачи чата»: tabs «Открытые · N / Готово / Отменённые» over
 * listChatTasks, «На вас» marked with a red line. A tap opens the task.
 */
export function ChatTasksScreen({ chatID }: { chatID: string }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { api, user } = useSignedIn();
  const { members } = useChatMembers(chatID);
  const viewer = useTaskViewer(chatID, members);
  const [state, setState] = useState<ListState>("open");
  const query = useInfiniteQuery({
    queryKey: [...taskKeys.chat(user.id, chatID, state), "all"],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.chatTasks(chatID, { state, cursor: pageParam, limit: 50 }),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });
  const items = useMemo(
    () =>
      (query.data?.pages.flatMap((page) => page.items) ?? []).filter(
        hasTask,
      ) as unknown as TaskRowMessage[],
    [query.data],
  );
  const counts = query.data?.pages[0]?.counts;
  const tabs: { id: ListState; label: string; count?: number }[] = [
    {
      id: "open",
      label: t("taskTabOpen"),
      count: state === "open" ? counts?.open : undefined,
    },
    { id: "done", label: t("taskTabDone") },
    { id: "canceled", label: t("taskTabCanceled") },
  ];
  return (
    <SafeAreaView
      testID="chat-tasks"
      edges={["bottom"]}
      style={[styles.screen, { backgroundColor: theme.surface }]}
    >
      <ScreenHeader title={t("taskPanelAll")} backTestID="chat-tasks-back" />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        accessibilityRole="tablist"
        contentContainerStyle={styles.chips}
        style={styles.strip}
      >
        {tabs.map((tab) => (
          <TabChip
            key={tab.id}
            testID={`chat-tasks-tab-${tab.id}`}
            label={tab.label}
            count={tab.count}
            selected={state === tab.id}
            onPress={() => setState(tab.id)}
          />
        ))}
      </ScrollView>
      <FlatList
        testID="chat-tasks-list"
        data={items}
        keyExtractor={(item) => item.id}
        renderItem={({ item, index }) => (
          <TaskRow
            testID={`chat-task-${index}`}
            message={item}
            viewer={viewer}
            members={members}
            mine={state === "open" && isTaskOnMe(item.task, user.id)}
            onOpen={() => router.push(`/chat/${chatID}/task/${item.id}`)}
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
        ListEmptyComponent={
          query.isPending ? (
            <ActivityIndicator style={styles.loader} color={theme.muted} />
          ) : query.isError ? (
            <View style={styles.state}>
              <Notice
                title={t("taskListLoadFailed")}
                actionLabel={t("retry")}
                onAction={() => void query.refetch()}
              />
            </View>
          ) : (
            <Text tone="muted" size={15} style={styles.empty}>
              {t(`taskListEmpty_${state}`)}
            </Text>
          )
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  strip: { flexGrow: 0 },
  chips: { gap: 6, paddingHorizontal: 14, paddingBottom: 10 },
  loader: { marginTop: 40 },
  more: { marginVertical: 16 },
  state: { padding: 20 },
  empty: { textAlign: "center", padding: 32 },
});
