import { useMemo } from "react";
import { useInfiniteQuery, useQueries } from "@tanstack/react-query";
import { ListChecks } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import {
  groupMyTasks,
  hasTask,
  mergeTaskItems,
  myTaskGroupLabelKeys,
  newerTask,
  taskKeys,
  type ChatMember,
  type MyTaskItem,
  type TaskInboxMode,
  type WaitingInboxItem,
} from "@comamessenger/core";
import { Button, EmptyState, InlineError, SkeletonRow, cx } from "../ui";
import { hasPermission } from "../settings";
import { titleOf } from "../lib/chats";
import { useMessenger } from "../shell/MessengerContext";
import { TaskRow } from "./TaskRow";

/** One list of Waiting for you, page by page. */
export function useWaitingInbox(
  kind: "all" | "requests" | "tasks" | "polls",
  enabled: boolean,
) {
  const { api, user } = useMessenger();
  return useInfiniteQuery({
    // taskKeys.waiting predates polls; the key keeps its shape.
    queryKey:
      kind === "polls"
        ? ([...taskKeys.all(user.id), "waiting", kind] as const)
        : taskKeys.waiting(user.id, kind),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.waitingInbox({ kind, cursor: pageParam }),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    enabled,
  });
}

/** On me or Set by me, open or done in the last 7 days. */
export function useMyTasks(
  role: "assigned" | "authored",
  state: "open" | "done",
  enabled: boolean,
) {
  const { api, user } = useMessenger();
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

/**
 * Waiting for you → Tasks: tasks from every chat by due date — Overdue ·
 * Today · Later · No due date · Done in 7 days (prototype E). On me
 * reads the waiting list and the done ones; Set by me the author's.
 */
export function MyTasks({ mode }: { mode: TaskInboxMode }) {
  const { t } = useTranslation();
  const { store, user, navigate } = useMessenger();
  const assigned = mode === "assigned";
  const waiting = useWaitingInbox("tasks", assigned);
  const authoredOpen = useMyTasks("authored", "open", !assigned);
  const done = useMyTasks(mode, "done", true);
  const openQuery = assigned ? waiting : authoredOpen;
  const chats = useStore(store, (state) => state.chats);
  const storeMessages = useStore(store, (state) => state.messages);

  const items = useMemo(() => {
    const open: MyTaskItem[] = assigned
      ? (waiting.data?.pages.flatMap((page) => page.items) ?? [])
          .map(asMyTask)
          .filter((item): item is MyTaskItem => item !== null)
      : (authoredOpen.data?.pages.flatMap((page) => page.items) ?? []);
    const closed = done.data?.pages.flatMap((page) => page.items) ?? [];
    return mergeTaskItems(open, closed).map((item) => {
      // The feed may hold a fresher copy (task.updated came meanwhile).
      const fresh = storeMessages[item.chat.id]?.find(
        (message) => message.id === item.message.id,
      )?.task;
      const task = newerTask(item.message.task, fresh);
      return task === item.message.task
        ? item
        : { ...item, message: { ...item.message, task } };
    });
  }, [assigned, authoredOpen.data, done.data, storeMessages, waiting.data]);
  const groups = groupMyTasks(items, new Date());

  // Names of the responsible people: the members of the chats in the list.
  const chatIDs = useMemo(
    () => [...new Set(items.map((item) => item.chat.id))],
    [items],
  );
  const { api } = useMessenger();
  const memberQueries = useQueries({
    queries: chatIDs.map((chatID) => ({
      queryKey: ["chat-members", chatID],
      queryFn: () => api.members(chatID),
      staleTime: 60_000,
    })),
  });
  const membersOf = (chatID: string): ChatMember[] =>
    (memberQueries[chatIDs.indexOf(chatID)]?.data as
      | ChatMember[]
      | undefined) ?? [];

  if (openQuery.isLoading)
    return (
      <>
        <SkeletonRow lines={["60%", "40%"]} />
        <SkeletonRow lines={["70%", "35%"]} />
      </>
    );
  if (openQuery.isError)
    return (
      <InlineError
        center
        title={t("taskListLoadFailed")}
        retryLabel={t("retry")}
        onRetry={() => void openQuery.refetch()}
      />
    );
  if (!groups.length)
    return (
      <EmptyState
        icon={<ListChecks />}
        title={t(assigned ? "taskMineEmpty" : "taskAuthoredEmpty")}
        hint={t(assigned ? "taskMineEmptyHint" : "taskAuthoredEmptyHint")}
      />
    );
  return (
    <div className="my-tasks">
      {groups.map((group) => (
        <section
          key={group.kind}
          className="my-tasks__group"
          aria-label={t(myTaskGroupLabelKeys[group.kind])}
        >
          <h2
            className={cx(
              "inbox__section",
              group.kind === "overdue" && "inbox__section--danger",
            )}
          >
            {t("taskGroupCount", {
              group: t(myTaskGroupLabelKeys[group.kind]),
              count: group.items.length,
            })}
          </h2>
          <div className="my-tasks__rows">
            {group.items.map((item) => {
              const chat = chats[item.chat.id];
              const message = item.message;
              if (!hasTask(message)) return null;
              const members = membersOf(item.chat.id);
              const member = members.find(
                (entry) => entry.actor_id === user.id,
              );
              return (
                <TaskRow
                  key={message.id}
                  message={message}
                  viewer={{
                    actorID: user.id,
                    chatRole: chat?.role ?? member?.role ?? null,
                    moderator: hasPermission(user, "chats.moderate"),
                  }}
                  members={members}
                  chatName={
                    chat ? titleOf(chat, [], user.id) : item.chat.display_name
                  }
                  authorName={
                    assigned && item.author.actor_id !== user.id
                      ? item.author.display_name
                      : undefined
                  }
                  onOpen={() =>
                    navigate(`/chat/${item.chat.id}?message=${message.id}`)
                  }
                />
              );
            })}
          </div>
        </section>
      ))}
      {(openQuery.hasNextPage || done.hasNextPage) && (
        <div className="directory-list__more">
          <Button
            variant="ghost"
            size="sm"
            pending={openQuery.isFetchingNextPage || done.isFetchingNextPage}
            onClick={() => {
              if (openQuery.hasNextPage) void openQuery.fetchNextPage();
              else void done.fetchNextPage();
            }}
          >
            {t("importantLoadMore")}
          </Button>
        </div>
      )}
    </div>
  );
}
