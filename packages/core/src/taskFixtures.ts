import type { Message, MessageTask, MessageTaskItem } from "./types";

/** Test helpers for tasks: a whole MessageTask and its message. */

export function makeTask(overrides: Partial<MessageTask> = {}): MessageTask {
  const items: MessageTaskItem[] = overrides.items ?? [];
  return {
    title: "Проверить аптечку",
    description: "",
    status: "open",
    canceled_reason: null,
    status_changed_at: null,
    status_changed_by: null,
    assignee: {
      kind: "person",
      actor_id: "resp",
      label: "",
      candidate_ids: [],
      in_chat: true,
      department_id: null,
      position_id: null,
    },
    due_at: null,
    remind_before_due: false,
    source: null,
    last_nudge_at: null,
    nudge_count: 0,
    version: 1,
    ...overrides,
    items,
    items_done:
      overrides.items_done ?? items.filter((item) => item.done_at).length,
  };
}

export function makeItem(
  id: string,
  overrides: Partial<MessageTaskItem> = {},
): MessageTaskItem {
  return {
    id,
    text: `Пункт ${id}`,
    assignee_id: null,
    assignee_in_chat: true,
    done_at: null,
    done_by: null,
    ...overrides,
  };
}

export function makeTaskMessage(
  id: string,
  task: MessageTask,
  overrides: Partial<Message> = {},
): Message & { task: MessageTask } {
  return {
    id,
    chat_id: "c1",
    actor_id: "author",
    client_msg_id: id,
    type: "task",
    body: task.title,
    body_format: "markdown",
    version: 1,
    created_seq: 1,
    created_at: "2026-11-12T08:00:00Z",
    mentioned_actor_ids: [],
    thread_reply_count: 0,
    files: [],
    ...overrides,
    task,
  } as Message & { task: MessageTask };
}
