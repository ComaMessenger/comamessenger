import { useCallback, useMemo, useRef, useState } from "react";
import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useStore } from "zustand";
import {
  optimisticTakeTask,
  optimisticTaskItemAdd,
  optimisticTaskItemChange,
  optimisticTaskItemDelete,
  optimisticTaskItemDone,
  optimisticTaskNudge,
  optimisticTaskStatus,
  optimisticTaskUpdate,
  performTaskAction,
  taskKeys,
  tasksAvailable,
  type Message,
  type MessageTask,
  type MessengerState,
  type TaskCacheAccess,
  type TaskStatus,
  type UpdateTaskRequest,
} from "@comamessenger/core";
import type { StoreApi } from "zustand";
import { useMessenger } from "@/messenger/MessengerProvider";
import { useSignedIn } from "@/session/SessionProvider";
import { useTaskErrorText } from "./format";

/** The server announced message_tasks. */
export function useTasksAvailable(): boolean {
  const { store } = useMessenger();
  const features = useStore(store, (state) => state.features);
  return tasksAvailable(features);
}

/** Open tasks of a chat with the counts: the slot and the list under it. */
export function useChatTasks(chatID: string, enabled = true) {
  const { api, user } = useSignedIn();
  const available = useTasksAvailable();
  return useQuery({
    queryKey: taskKeys.chat(user.id, chatID, "open"),
    queryFn: () => api.chatTasks(chatID, { state: "open", limit: 100 }),
    enabled: available && enabled,
    staleTime: 15_000,
  });
}

type WithItems = { items: unknown[] };

/** Replaces the task of one message wherever a task list holds it. */
export function patchTaskLists(
  queryClient: QueryClient,
  userID: string,
  messageID: string,
  task: MessageTask,
) {
  const patchMessage = <T extends { id: string; task?: MessageTask | null }>(
    message: T,
  ): T => (message.id === messageID ? { ...message, task } : message);
  const patchItems = (page: WithItems): WithItems => ({
    ...page,
    items: page.items.map((item) => {
      const value = item as Record<string, unknown>;
      if (value.message && typeof value.message === "object") {
        const message = value.message as Message;
        const next = patchMessage(message);
        return next === message
          ? item
          : {
              ...value,
              message: next,
              ...("due_at" in value ? { due_at: task.due_at } : {}),
            };
      }
      return typeof value.id === "string"
        ? patchMessage(value as unknown as Message)
        : item;
    }),
  });
  queryClient.setQueriesData<unknown>(
    { queryKey: taskKeys.all(userID) },
    (data: unknown) => {
      if (!data || typeof data !== "object") return data;
      const value = data as Record<string, unknown>;
      if (Array.isArray(value.pages))
        return {
          ...value,
          pages: (value.pages as unknown[]).map((page) =>
            page && typeof page === "object" && "items" in page
              ? patchItems(page as WithItems)
              : page,
          ),
        };
      if (Array.isArray(value.items)) return patchItems(value as WithItems);
      if (typeof value.id === "string" && value.task)
        return patchMessage(value as unknown as Message);
      return data;
    },
  );
}

/**
 * Where the task of one message is read and written by an action: the
 * store (the feed), every task list in the query cache, and the last copy
 * the screen was drawn from when the message is in no feed.
 */
export function taskCacheFor(
  store: StoreApi<MessengerState>,
  queryClient: QueryClient,
  userID: string,
  message: Pick<Message, "id" | "chat_id"> & { task: MessageTask },
  latest: { current: MessageTask },
): TaskCacheAccess {
  return {
    read: () =>
      store.getState().taskOf(message.id, message.chat_id) ?? latest.current,
    write: (task) => {
      latest.current = task;
      if (store.getState().taskOf(message.id, message.chat_id))
        store.getState().setTask(message.id, task, message.chat_id);
      patchTaskLists(queryClient, userID, message.id, task);
    },
  };
}

export type TaskBusy = "status" | "take" | "item" | "nudge" | "update" | null;

/** Reads the lists that may have gained or lost the task again. */
export function invalidateTaskLists(
  queryClient: QueryClient,
  userID: string,
  chatID: string,
) {
  void queryClient.invalidateQueries({
    queryKey: [...taskKeys.all(userID), "waiting"],
  });
  void queryClient.invalidateQueries({
    queryKey: [...taskKeys.all(userID), "mine"],
  });
  void queryClient.invalidateQueries({
    queryKey: [...taskKeys.all(userID), "chat", chatID],
  });
}

/**
 * Status buttons, «Взять себе», items, «Напомнить» and edits with the
 * cache kept current: the change shows at once and rolls back with a
 * notice when the server refuses it.
 */
export function useTaskActions(
  message: Pick<Message, "id" | "chat_id" | "actor_id"> & {
    task: MessageTask;
  },
  onNotice?: (text: string) => void,
) {
  const { api, user } = useSignedIn();
  const { store, scheduleReload } = useMessenger();
  const queryClient = useQueryClient();
  const errorText = useTaskErrorText();
  const [busy, setBusy] = useState<TaskBusy>(null);
  const latest = useRef(message.task);
  if (message.task.version >= latest.current.version)
    latest.current = message.task;
  const cache = useMemo(
    () => taskCacheFor(store, queryClient, user.id, message, latest),
    // The message identity changes with every task version; the cache
    // reads the current task itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, queryClient, user.id, message.id, message.chat_id],
  );

  const run = useCallback(
    async (
      kind: Exclude<TaskBusy, null>,
      optimistic: (task: MessageTask) => MessageTask | null,
      send: () => Promise<MessageTask | Pick<Message, "task"> | void>,
      options: { lists?: boolean } = {},
    ): Promise<boolean> => {
      const current = cache.read() ?? message.task;
      setBusy(kind);
      try {
        await performTaskAction(cache, optimistic(current), send);
        if (options.lists) {
          // Who the task waits for may have changed: the lists and the
          // counters follow (task.updated does the same on other devices).
          invalidateTaskLists(queryClient, user.id, message.chat_id);
          scheduleReload();
        }
        return true;
      } catch (error) {
        onNotice?.(errorText(error));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [
      cache,
      errorText,
      message.chat_id,
      message.task,
      onNotice,
      queryClient,
      scheduleReload,
      user.id,
    ],
  );

  const authorID = message.actor_id;
  return {
    busy,
    setStatus: (status: TaskStatus) =>
      run(
        "status",
        (task) =>
          optimisticTaskStatus(task, status, user.id, authorID, new Date()),
        () => {
          const task = cache.read() ?? message.task;
          return api.setTaskStatus(message.id, {
            status,
            expected_version: task.version,
          });
        },
        { lists: true },
      ),
    take: () =>
      run(
        "take",
        (task) => optimisticTakeTask(task, user.id),
        () => api.takeTask(message.id),
        { lists: true },
      ),
    checkItem: (itemID: string, done: boolean) =>
      run(
        "item",
        (task) =>
          optimisticTaskItemDone(task, itemID, done, user.id, new Date()),
        () => api.updateTaskItem(message.id, itemID, { done }),
        { lists: true },
      ),
    changeItem: (
      itemID: string,
      change: { text?: string; assigneeID?: string | null },
    ) =>
      run(
        "item",
        (task) => optimisticTaskItemChange(task, itemID, change),
        () =>
          api.updateTaskItem(message.id, itemID, {
            ...(change.text !== undefined ? { text: change.text.trim() } : {}),
            ...(change.assigneeID !== undefined
              ? { assignee_id: change.assigneeID }
              : {}),
          }),
        { lists: change.assigneeID !== undefined },
      ),
    addItem: (text: string, assigneeID: string | null) =>
      run(
        "item",
        (task) =>
          optimisticTaskItemAdd(task, {
            id: `local-${crypto.randomUUID()}`,
            text,
            assigneeID,
          }),
        () =>
          api.addTaskItem(message.id, {
            text: text.trim(),
            ...(assigneeID ? { assignee_id: assigneeID } : {}),
          }),
        { lists: Boolean(assigneeID) },
      ),
    deleteItem: (itemID: string) =>
      run(
        "item",
        (task) => optimisticTaskItemDelete(task, itemID),
        async () => {
          await api.deleteTaskItem(message.id, itemID);
          // 204 carries no task: task.updated brings the new version.
          return undefined;
        },
        { lists: true },
      ),
    nudge: () =>
      run(
        "nudge",
        (task) => optimisticTaskNudge(task, new Date()),
        async () => {
          await api.nudgeTask(message.id);
          return undefined;
        },
      ),
    update: (input: UpdateTaskRequest) =>
      run(
        "update",
        (task) => optimisticTaskUpdate(task, input),
        () => api.updateTask(message.id, input),
        { lists: true },
      ),
  };
}

export type TaskActions = ReturnType<typeof useTaskActions>;
