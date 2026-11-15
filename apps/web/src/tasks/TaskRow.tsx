import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  formatTaskDue,
  isTaskActive,
  isTaskHot,
  taskPermissions,
  type ChatMember,
  type Message,
  type MessageTask,
  type TaskViewer,
} from "@comamessenger/core";
import { Avatar, cx } from "../ui";
import { calendarLocale } from "../requests/format";
import { taskAssigneeText } from "./TaskCard";
import { useTaskActions } from "./useTasks";
import { useMessenger } from "../shell/MessengerContext";

/**
 * One task in a list (the list under the slot, Waiting for you → Tasks, All tasks
 * of the chat): the round Done for those who may close it, the title,
 * who answers, the due date (red when it burns), «2/3» and, outside the
 * chat, the chat's name. A click opens the card.
 */
export function TaskRow({
  message,
  viewer,
  members = [],
  authorName,
  responsibleName,
  chatName,
  mine = false,
  onOpen,
  now = new Date(),
}: {
  message: Pick<Message, "id" | "chat_id" | "actor_id" | "created_at"> & {
    task: MessageTask;
  };
  viewer: TaskViewer;
  members?: readonly ChatMember[];
  /** The author, when the list is Set by me or outside the chat. */
  authorName?: string;
  /** The responsible person's name when members are not at hand. */
  responsibleName?: string;
  chatName?: string;
  /** On you: the red line on the left. */
  mine?: boolean;
  onOpen(): void;
  now?: Date;
}) {
  const { t } = useTranslation();
  const actions = useTaskActions(message);
  const { user } = useMessenger();
  const task = message.task;
  const permissions = taskPermissions(task, message.actor_id, viewer);
  const done = task.status === "done";
  const canToggle = done ? permissions.reopen : permissions.complete;
  const hot = isTaskHot(task, now);
  const nameOf = (id: string) =>
    (id === user.id ? user.display_name : undefined) ??
    members.find((member) => member.actor_id === id)?.display_name ??
    responsibleName ??
    t("taskSomeone");
  const assigneeID = task.assignee.actor_id;
  const who =
    assigneeID === viewer.actorID
      ? t("taskOnYou")
      : taskAssigneeText(task, nameOf, t, viewer.actorID);
  const parts: ReactNode[] = [];
  if (task.due_at)
    parts.push(
      <span key="due" className={cx(hot && "task-row__hot")}>
        {formatTaskDue(new Date(task.due_at), now, calendarLocale())}
      </span>,
    );
  if (task.items.length)
    parts.push(
      <span key="items" className="tabular">
        {`${task.items_done}/${task.items.length}`}
      </span>,
    );
  if (chatName) parts.push(<span key="chat">{chatName}</span>);
  if (authorName) parts.push(<span key="author">{t("taskFrom", { name: authorName })}</span>);
  return (
    <div
      className={cx(
        "task-row",
        mine && "task-row--mine",
        !isTaskActive(task) && "task-row--closed",
      )}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={done}
        aria-label={t(done ? "taskRowReopen" : "taskRowComplete", {
          title: task.title,
        })}
        className="task-check task-check--round"
        disabled={!canToggle || actions.busy === "status"}
        onClick={() => void actions.setStatus(done ? "open" : "done")}
      >
        {done && <Check aria-hidden="true" />}
      </button>
      <button type="button" className="task-row__body" onClick={onOpen}>
        <strong className={cx("task-row__title", done && "task-row__title--done")}>
          {task.title}
        </strong>
        <small className="task-row__meta">
          <span className="task-row__who">
            {assigneeID && (
              <Avatar
                name={nameOf(assigneeID)}
                seed={assigneeID}
                actorID={assigneeID}
                size="xs"
              />
            )}
            {who}
          </span>
          {parts.map((part, index) => (
            <span key={index} className="task-row__part">
              {" · "}
              {part}
            </span>
          ))}
          {task.status === "in_progress" && (
            <span className="task-pill task-pill--in_progress">
              {t("taskStatusInProgress")}
            </span>
          )}
        </small>
      </button>
    </div>
  );
}
