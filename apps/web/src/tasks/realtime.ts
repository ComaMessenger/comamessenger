import type { QueryClient } from "@tanstack/react-query";
import {
  isTaskEvent,
  parseTaskEvent,
  reduceTaskList,
  taskKeys,
  type ChatTaskPage,
  type DurableEvent,
} from "@comamessenger/core";

/**
 * Keeps the task lists in the query cache current after a realtime event.
 * The store already put task.updated into the feed; here follow the open
 * tasks of the chat (the slot and its list), Waiting for you, My tasks and
 * the closed tabs of All tasks of the chat. Lists are short: what may have
 * moved in or out is read again rather than patched across pages.
 */
export function applyTaskEvent(
  queryClient: QueryClient,
  userID: string,
  event: DurableEvent,
): void {
  const chatID =
    typeof event.chat_id === "string"
      ? event.chat_id
      : typeof event.data.chat_id === "string"
        ? event.data.chat_id
        : null;
  const lists = (...rest: string[]) =>
    void queryClient.invalidateQueries({
      queryKey: [...taskKeys.all(userID), ...rest],
    });

  if (isTaskEvent(event.type)) {
    const parsed = parseTaskEvent(event);
    if (!parsed) {
      lists();
      return;
    }
    if (parsed.type === "task.notified") {
      // Assigned, taken by someone else, reopened: Waiting for you changes.
      lists("waiting");
      lists("mine");
      return;
    }
    const update = parsed.data;
    const key = taskKeys.chat(userID, update.chat_id, "open");
    const page = queryClient.getQueryData<ChatTaskPage>(key);
    if (page) {
      const reduced = reduceTaskList(page.items, update, { list: "chatOpen" });
      if (reduced.changed)
        queryClient.setQueryData<ChatTaskPage>(key, {
          ...page,
          items: reduced.items,
        });
      // Counts (N on you) come from the server: read them again.
      void queryClient.invalidateQueries({ queryKey: key });
    }
    lists("chat", update.chat_id, "done");
    lists("chat", update.chat_id, "canceled");
    lists("waiting");
    lists("mine");
    lists("task", update.message_id);
    return;
  }

  const isTaskMessage = event.data.type === "task" || Boolean(event.data.task);
  if (
    chatID &&
    ((event.type === "message.created" && isTaskMessage) ||
      event.type === "message.deleted" ||
      (event.type === "message.updated" && isTaskMessage))
  ) {
    lists("chat", chatID);
    if (event.type !== "message.created") {
      lists("waiting");
      lists("mine");
    }
  }
  // not in the chat is computed when a list is built: read it again.
  if (chatID && event.type === "member.removed")
    lists("chat", chatID);
  // The slot shows pinned messages.
  if (
    chatID &&
    (event.type === "message.pinned" ||
      event.type === "message.unpinned" ||
      event.type === "message.deleted")
  )
    void queryClient.invalidateQueries({ queryKey: ["pins", chatID] });
}
