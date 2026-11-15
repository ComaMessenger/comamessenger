import { useRef, useState, type ReactNode } from "react";
import {
  Bell,
  Check,
  Clock3,
  Flame,
  ListChecks,
  MessagesSquare,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  Undo2,
  Users,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  formatTaskDue,
  isTaskActive,
  taskCardView,
  type ChatMember,
  type Message,
  type MessageTask,
  type TaskCardView,
  type TaskStatus,
  type TaskViewer,
} from "@comamessenger/core";
import {
  Avatar,
  Button,
  FloatingPopover,
  IconButton,
  Menu,
  MenuItem,
  cx,
} from "../ui";
import { Markdown } from "../markdown";
import { ConfirmDialog } from "../dialogs/ConfirmDialog";
import { formatTime } from "../lib/format";
import { calendarLocale } from "../requests/format";

export type TaskCardActions = {
  setStatus(status: TaskStatus): Promise<boolean>;
  take(): Promise<boolean>;
  checkItem(itemID: string, done: boolean): Promise<boolean>;
  nudge(): Promise<boolean>;
  busy: "status" | "take" | "item" | "nudge" | "update" | null;
};

export type TaskMessageShape = Pick<
  Message,
  "id" | "chat_id" | "actor_id" | "created_at"
> & { task: MessageTask };

/** Open, In progress, Done, Canceled. */
export const taskStatusKeys: Record<TaskStatus, string> = {
  open: "taskStatusOpen",
  in_progress: "taskStatusInProgress",
  done: "taskStatusDone",
  canceled: "taskStatusCanceled",
};

/** The pill of the card head: the status, or red Overdue. */
export function TaskPill({ view }: { view: Pick<TaskCardView, "pill"> }) {
  const { t } = useTranslation();
  const pill = view.pill;
  if (pill.kind === "overdue")
    return (
      <span className="task-pill task-pill--overdue">
        {t("taskPillOverdue")}
      </span>
    );
  return (
    <span className={cx("task-pill", `task-pill--${pill.status}`)}>
      {t(taskStatusKeys[pill.status])}
    </span>
  );
}

/** Who answers for the task: a person, or the queue of a group. */
export function taskAssigneeText(
  task: MessageTask,
  nameOf: (actorID: string) => string,
  t: (key: string, values?: Record<string, unknown>) => string,
  selfID: string,
): string {
  const assignee = task.assignee;
  if (assignee.actor_id)
    return assignee.actor_id === selfID ? t("taskYou") : nameOf(assignee.actor_id);
  return t(
    assignee.kind === "department" ? "taskQueueDepartment" : "taskQueuePosition",
    { label: assignee.label },
  );
}

/**
 * The task in the feed, as in Components: the head Task · 1 of 3
 * with the status or a red Overdue, the title (struck out when done),
 * the description, who answers and when, the checklist with its people,
 * from a message, and the buttons this reader may press. Pure: the row
 * passes the viewer and the actions.
 */
export function TaskCard({
  message,
  members,
  viewer,
  actions,
  memberIDs,
  onOpen,
  onThread,
  onSource,
  hideItems = false,
  now = new Date(),
}: {
  message: TaskMessageShape;
  members: readonly ChatMember[];
  viewer: TaskViewer;
  actions: TaskCardActions;
  /** Members of the chat now: tells an empty queue. */
  memberIDs?: ReadonlySet<string>;
  /** Edit / Details: the task panel. */
  onOpen?(): void;
  /** Discuss in thread. */
  onThread?(): void;
  /** from a message …: jump to the source. */
  onSource?(messageID: string): void;
  /** The task screen shows the checklist in its own editor. */
  hideItems?: boolean;
  now?: Date;
}) {
  const { t } = useTranslation();
  const locale = calendarLocale();
  const task = message.task;
  const view = taskCardView(message, viewer, now, memberIDs);
  const permissions = view.permissions;
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const menuAnchor = useRef<HTMLDivElement>(null);
  const nameOf = (actorID: string) =>
    members.find((member) => member.actor_id === actorID)?.display_name ??
    t("taskSomeone");
  const memberOf = (actorID: string) =>
    members.find((member) => member.actor_id === actorID);
  const self = viewer.actorID;
  const progress = view.progress;
  const assigneeID = task.assignee.actor_id;
  const busy = actions.busy;
  const canEditSomething =
    permissions.edit || permissions.manageItems || permissions.reassign;

  const buttons: ReactNode[] = [];
  if (permissions.take)
    buttons.push(
      <Button
        key="take"
        size="sm"
        variant="primary"
        pending={busy === "take"}
        onClick={() => void actions.take()}
      >
        {t("taskTake")}
      </Button>,
    );
  if (task.status === "open" && permissions.start)
    buttons.push(
      <Button
        key="start"
        size="sm"
        pending={busy === "status"}
        onClick={() => void actions.setStatus("in_progress")}
      >
        {t("taskStart")}
      </Button>,
    );
  if (isTaskActive(task) && permissions.complete)
    buttons.push(
      <Button
        key="done"
        size="sm"
        variant="primary"
        pending={busy === "status"}
        onClick={() => void actions.setStatus("done")}
      >
        <Check aria-hidden="true" />
        {t("taskComplete")}
      </Button>,
    );
  if (task.status === "done" && permissions.reopen)
    buttons.push(
      <Button
        key="reopen"
        size="sm"
        pending={busy === "status"}
        onClick={() => void actions.setStatus("open")}
      >
        <RotateCcw aria-hidden="true" />
        {t("taskReopen")}
      </Button>,
    );
  if (task.status === "canceled" && permissions.restore)
    buttons.push(
      <Button
        key="restore"
        size="sm"
        pending={busy === "status"}
        onClick={() => void actions.setStatus("open")}
      >
        <Undo2 aria-hidden="true" />
        {t("taskRestore")}
      </Button>,
    );
  if (view.nudge.kind === "ready")
    buttons.push(
      <Button
        key="nudge"
        size="sm"
        pending={busy === "nudge"}
        onClick={() => void actions.nudge()}
      >
        <Bell aria-hidden="true" />
        {view.queue ? t("taskNudgeQueue") : t("taskNudge")}
      </Button>,
    );

  const statusLine =
    (task.status === "done" || task.status === "canceled") &&
    task.status_changed_at
      ? t(
          task.status === "done"
            ? "taskClosedBy"
            : task.canceled_reason === "message_deleted"
              ? "taskCanceledDeleted"
              : "taskCanceledBy",
          {
            name: task.status_changed_by
              ? task.status_changed_by === self
                ? t("taskYou")
                : nameOf(task.status_changed_by)
              : t("taskSomeone"),
            time: formatTime(task.status_changed_at),
          },
        )
      : null;

  const hasMenu =
    Boolean(onOpen) ||
    Boolean(onThread) ||
    permissions.cancel ||
    (task.status === "in_progress" && permissions.stop);

  return (
    <div
      className={cx(
        "task-card",
        task.status === "done" && "task-card--done",
        task.status === "canceled" && "task-card--canceled",
        view.hot && "task-card--hot",
      )}
      data-task-role={view.role ?? "none"}
    >
      <div className="task-card__head" ref={menuAnchor}>
        <ListChecks aria-hidden="true" />
        <span>
          {progress.total
            ? t("taskCardLabelProgress", {
                done: progress.done,
                total: progress.total,
              })
            : t("taskCardLabel")}
        </span>
        <TaskPill view={view} />
        {hasMenu && (
          <IconButton
            size="icon-sm"
            className="task-card__more"
            label={t("taskMenu")}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <MoreHorizontal />
          </IconButton>
        )}
      </div>
      <div
        className={cx(
          "task-card__title",
          (task.status === "done" || task.status === "canceled") &&
            "task-card__title--closed",
        )}
      >
        {task.title}
      </div>
      {task.description && (
        <div className="task-card__desc">
          <Markdown source={task.description} />
        </div>
      )}
      <div className="task-card__meta">
        {assigneeID ? (
          <span className="task-card__who">
            <Avatar
              name={nameOf(assigneeID)}
              seed={assigneeID}
              actorID={assigneeID}
              avatarVersion={memberOf(assigneeID)?.avatar_version}
              size="xs"
            />
            <span>
              {t("taskResponsible", {
                name: taskAssigneeText(task, nameOf, t, self),
              })}
              {view.assigneeAway && (
                <span className="task-card__away">
                  {" · "}
                  {t("taskNotInChat")}
                </span>
              )}
            </span>
          </span>
        ) : (
          <span className="task-card__who">
            <Users aria-hidden="true" />
            <span>
              {taskAssigneeText(task, nameOf, t, self)}
              {" · "}
              {t("taskQueueHint", { count: task.assignee.candidate_ids.length })}
            </span>
          </span>
        )}
        {view.dueAt && (
          <span
            className={cx(
              "task-card__due",
              view.hot && "task-card__due--hot",
            )}
          >
            {view.hot ? <Flame aria-hidden="true" /> : <Clock3 aria-hidden="true" />}
            {formatTaskDue(view.dueAt, now, locale)}
          </span>
        )}
      </div>

      {task.items.length > 0 && !hideItems && (
        <ul className="task-card__items" aria-label={t("taskChecklist")}>
          {task.items.map((item) => {
            const allowed = permissions.checkItems.includes(item.id);
            const done = Boolean(item.done_at);
            return (
              <li
                key={item.id}
                className={cx("task-item", done && "task-item--done")}
              >
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={done}
                  aria-label={item.text}
                  className="task-check"
                  disabled={!allowed || busy === "item"}
                  onClick={() => void actions.checkItem(item.id, !done)}
                >
                  {done && <Check aria-hidden="true" />}
                </button>
                <span className="task-item__text">{item.text}</span>
                {item.assignee_id && (
                  <span
                    className="task-item__who"
                    title={nameOf(item.assignee_id)}
                  >
                    {!item.assignee_in_chat && (
                      <span className="task-card__away">
                        {t("taskNotInChat")}
                      </span>
                    )}
                    <Avatar
                      name={nameOf(item.assignee_id)}
                      seed={item.assignee_id}
                      actorID={item.assignee_id}
                      avatarVersion={memberOf(item.assignee_id)?.avatar_version}
                      size="xs"
                    />
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {task.source && (
        <button
          type="button"
          className="task-card__source"
          disabled={task.source.deleted || !onSource}
          onClick={() => onSource?.(task.source!.message_id)}
        >
          {task.source.deleted
            ? t("taskSourceDeleted")
            : t("taskSource", {
                name: nameOf(task.source.author_id),
                excerpt: task.source.excerpt,
              })}
        </button>
      )}

      {view.queueEmpty && (permissions.reassign || permissions.edit) && (
        <div className="task-card__note task-card__note--warning">
          {t("taskQueueEmpty")}
        </div>
      )}
      {view.assigneeAway && permissions.reassign && (
        <div className="task-card__note task-card__note--warning">
          {t("taskAssigneeAwayHint")}
        </div>
      )}
      {view.suggestComplete && (
        <div className="task-card__note task-card__note--ok">
          {t("taskSuggestComplete")}
        </div>
      )}
      {statusLine && <div className="task-card__note">{statusLine}</div>}

      {(buttons.length > 0 || view.nudge.kind === "cooldown") && (
        <div className="task-card__actions">
          {buttons}
          {view.nudge.kind === "cooldown" && (
            <span className="task-card__note">
              {t("taskNudgeCooldown", {
                when: formatTaskDue(view.nudge.until, now, locale),
              })}
            </span>
          )}
        </div>
      )}

      {menuOpen && (
        <FloatingPopover
          anchorRef={menuAnchor}
          placement="bottom-end"
          width={220}
          onDismiss={() => setMenuOpen(false)}
        >
          <Menu label={t("taskMenu")}>
            {onOpen && (
              <MenuItem
                icon={<Pencil />}
                onClick={() => {
                  setMenuOpen(false);
                  onOpen();
                }}
              >
                {canEditSomething ? t("taskEdit") : t("taskDetails")}
              </MenuItem>
            )}
            {task.status === "in_progress" && permissions.stop && (
              <MenuItem
                icon={<RotateCcw />}
                onClick={() => {
                  setMenuOpen(false);
                  void actions.setStatus("open");
                }}
              >
                {t("taskStop")}
              </MenuItem>
            )}
            {onThread && (
              <MenuItem
                icon={<MessagesSquare />}
                onClick={() => {
                  setMenuOpen(false);
                  onThread();
                }}
              >
                {t("taskDiscuss")}
              </MenuItem>
            )}
            {permissions.cancel && (
              <MenuItem
                danger
                icon={<X />}
                onClick={() => {
                  setMenuOpen(false);
                  setConfirmCancel(true);
                }}
              >
                {t("taskCancel")}
              </MenuItem>
            )}
          </Menu>
        </FloatingPopover>
      )}
      {confirmCancel && (
        <ConfirmDialog
          danger
          title={t("taskCancelTitle")}
          description={t("taskCancelHint")}
          confirmLabel={t("taskCancel")}
          pending={busy === "status"}
          onConfirm={() =>
            void actions
              .setStatus("canceled")
              .then(() => setConfirmCancel(false))
          }
          onClose={() => setConfirmCancel(false)}
        />
      )}
    </div>
  );
}
