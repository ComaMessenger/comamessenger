import { useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  ArrowUpRight,
  Check,
  ChevronLeft,
  MessagesSquare,
  Plus,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import {
  formatTaskDue,
  fromLocalInputValue,
  hasTask,
  newerTask,
  remindBeforeDueAvailable,
  taskCardView,
  taskDraftFromTask,
  taskDuePresets,
  taskKeys,
  taskLimits,
  taskUpdateInput,
  toLocalInputValue,
  type ChatMember,
  type Message,
  type MessageTask,
  type TaskDraft,
  type TaskViewer,
} from "@comamessenger/core";
import {
  Avatar,
  Button,
  Chip,
  EmptyState,
  FormError,
  IconButton,
  InlineError,
  SkeletonRow,
  Switch,
  Tabs,
  cx,
} from "../ui";
import { useIsMobile } from "../lib/useMediaQuery";
import { useMessenger } from "../shell/MessengerContext";
import { calendarLocale } from "../requests/format";
import { TaskCard } from "./TaskCard";
import { TaskRow } from "./TaskRow";
import { MemberPicker } from "./MemberPicker";
import { useTaskViewer } from "./format";
import { useTaskActions, type TaskActions } from "./useTasks";

type TaskMessage = Message & { task: MessageTask };

/**
 * The panel where the thread lives: All tasks of the chat with Open /
 * Done / Canceled, or one task — its card, the fields its author may
 * change and the checklist. A page of its own on phones.
 */
export function TaskPanel({
  chatID,
  members,
  panel,
  onOpenTask,
  onJump,
  onClose,
}: {
  chatID: string;
  members: ChatMember[];
  panel: { kind: "list" } | { kind: "task"; messageID: string };
  onOpenTask(messageID: string): void;
  onJump(messageID: string): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const viewer = useTaskViewer(chatID, members);
  return (
    <aside
      className={cx("thread-panel", "task-panel")}
      aria-label={
        panel.kind === "list" ? t("taskPanelAll") : t("taskPanelTask")
      }
    >
      <header className="thread-panel__head">
        {isMobile && (
          <IconButton size="icon-lg" label={t("back")} onClick={onClose}>
            <ChevronLeft />
          </IconButton>
        )}
        <div className="thread-panel__title">
          <strong className="truncate">
            {panel.kind === "list" ? t("taskPanelAll") : t("taskPanelTask")}
          </strong>
        </div>
        {!isMobile && (
          <IconButton label={t("close")} onClick={onClose}>
            <X />
          </IconButton>
        )}
      </header>
      <div className="thread-panel__scroll task-panel__scroll">
        {panel.kind === "list" ? (
          <ChatTaskList
            chatID={chatID}
            members={members}
            viewer={viewer}
            onOpenTask={onOpenTask}
          />
        ) : (
          <TaskScreen
            key={panel.messageID}
            chatID={chatID}
            messageID={panel.messageID}
            members={members}
            viewer={viewer}
            onJump={onJump}
          />
        )}
      </div>
    </aside>
  );
}

type ListState = "open" | "done" | "canceled";

function ChatTaskList({
  chatID,
  members,
  viewer,
  onOpenTask,
}: {
  chatID: string;
  members: ChatMember[];
  viewer: TaskViewer;
  onOpenTask(messageID: string): void;
}) {
  const { t } = useTranslation();
  const { api, user } = useMessenger();
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
      (query.data?.pages.flatMap((page) => page.items) ?? []).filter(hasTask),
    [query.data],
  );
  const counts = query.data?.pages[0]?.counts;
  return (
    <div className="task-list">
      <Tabs<ListState>
        label={t("taskPanelAll")}
        value={state}
        onChange={setState}
        underline
        items={[
          {
            id: "open",
            label:
              counts && state === "open"
                ? t("taskTabOpenCount", { count: counts.open })
                : t("taskTabOpen"),
          },
          { id: "done", label: t("taskTabDone") },
          { id: "canceled", label: t("taskTabCanceled") },
        ]}
      />
      {query.isLoading ? (
        <>
          <SkeletonRow lines={["70%", "40%"]} />
          <SkeletonRow lines={["60%", "35%"]} />
        </>
      ) : query.isError ? (
        <InlineError
          title={t("taskListLoadFailed")}
          retryLabel={t("retry")}
          onRetry={() => void query.refetch()}
        />
      ) : items.length === 0 ? (
        <EmptyState compact title={t(`taskListEmpty_${state}`)} />
      ) : (
        <div className="task-list__rows" role="list">
          {items.map((message) => (
            <div role="listitem" key={message.id}>
              <TaskRow
                message={message}
                viewer={viewer}
                members={members}
                mine={
                  state === "open" &&
                  (message.task.assignee.actor_id === user.id ||
                    message.task.items.some(
                      (item) => item.assignee_id === user.id && !item.done_at,
                    ))
                }
                onOpen={() => onOpenTask(message.id)}
              />
            </div>
          ))}
          {query.hasNextPage && (
            <div className="directory-list__more">
              <Button
                variant="ghost"
                size="sm"
                pending={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {t("importantLoadMore")}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TaskScreen({
  chatID,
  messageID,
  members,
  viewer,
  onJump,
}: {
  chatID: string;
  messageID: string;
  members: ChatMember[];
  viewer: TaskViewer;
  onJump(messageID: string): void;
}) {
  const { t } = useTranslation();
  const { api, store, user, navigate } = useMessenger();
  const loaded = useStore(store, (state) =>
    state.messages[chatID]?.find((item) => item.id === messageID),
  );
  const fetched = useQuery({
    queryKey: taskKeys.task(user.id, messageID),
    queryFn: () => api.messageTask(messageID),
  });
  const base = loaded ?? fetched.data;
  const task = newerTask(loaded?.task, fetched.data?.task);
  if (!base || !task) {
    if (fetched.isError)
      return (
        <InlineError
          title={t("taskLoadFailed")}
          retryLabel={t("retry")}
          onRetry={() => void fetched.refetch()}
        />
      );
    return (
      <>
        <SkeletonRow lines={["50%", "90%"]} />
        <SkeletonRow lines={["80%", "40%"]} />
      </>
    );
  }
  const message: TaskMessage = { ...base, task };
  return (
    <TaskScreenBody
      message={message}
      members={members}
      viewer={viewer}
      onJump={() => onJump(message.id)}
      onThread={() => navigate(`/chat/${chatID}/thread/${message.id}`)}
    />
  );
}

function TaskScreenBody({
  message,
  members,
  viewer,
  onJump,
  onThread,
}: {
  message: TaskMessage;
  members: ChatMember[];
  viewer: TaskViewer;
  onJump(): void;
  onThread(): void;
}) {
  const { t } = useTranslation();
  const actions = useTaskActions(message);
  const view = taskCardView(message, viewer, new Date());
  const permissions = view.permissions;
  return (
    <div className="task-screen">
      <TaskCard
        message={message}
        members={members}
        viewer={viewer}
        actions={actions}
        onThread={onThread}
        onSource={() => onJump()}
        hideItems={permissions.manageItems}
      />
      {(permissions.edit || permissions.reassign) && (
        <TaskEditForm
          key={message.task.version}
          message={message}
          members={members}
          actions={actions}
          canEdit={permissions.edit}
          canReassign={permissions.reassign}
        />
      )}
      {permissions.manageItems && (
        <TaskItemsEditor
          message={message}
          members={members}
          actions={actions}
          checkable={permissions.checkItems}
        />
      )}
      <div className="task-screen__links">
        <Button size="sm" variant="ghost" onClick={onJump}>
          <ArrowUpRight aria-hidden="true" />
          {t("taskOpenInChat")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onThread}>
          <MessagesSquare aria-hidden="true" />
          {t("taskDiscuss")}
        </Button>
      </div>
    </div>
  );
}

type DueChoice =
  | "keep"
  | "none"
  | "today"
  | "tomorrow"
  | "nextWorkday"
  | "custom";

/** Title, description, due date, the reminder and the responsible person. */
function TaskEditForm({
  message,
  members,
  actions,
  canEdit,
  canReassign,
}: {
  message: TaskMessage;
  members: ChatMember[];
  actions: TaskActions;
  canEdit: boolean;
  canReassign: boolean;
}) {
  const { t } = useTranslation();
  const { user } = useMessenger();
  const locale = calendarLocale();
  const task = message.task;
  const [opened] = useState(() => new Date());
  const presets = useMemo(() => taskDuePresets(opened), [opened]);
  const [draft, setDraft] = useState<TaskDraft>(() => taskDraftFromTask(task));
  const [due, setDue] = useState<DueChoice>(task.due_at ? "keep" : "none");
  const [customDue, setCustomDue] = useState(() =>
    toLocalInputValue(
      task.due_at
        ? new Date(task.due_at)
        : new Date(opened.getTime() + 24 * 60 * 60_000),
    ),
  );
  const [error, setError] = useState("");
  const [picking, setPicking] = useState(false);
  const pickRef = useRef<HTMLButtonElement>(null);
  const dueAt =
    due === "keep"
      ? task.due_at
        ? new Date(task.due_at)
        : null
      : due === "none"
        ? null
        : due === "custom"
          ? fromLocalInputValue(customDue)
          : (presets.find((preset) => preset.id === due)?.at ?? null);
  const now = new Date();
  const input = taskUpdateInput(task, { ...draft, dueAt }, now);
  const remindAvailable = remindBeforeDueAvailable(dueAt, now);
  const people = members.filter((member) => member.type === "user");
  const personID =
    draft.assignee.kind === "person" ? draft.assignee.actorID : null;
  const nameOf = (id: string | null) =>
    (id && people.find((member) => member.actor_id === id)?.display_name) ||
    t("taskNobody");
  const titleEmpty = !draft.title.trim();

  async function save() {
    if (!input || titleEmpty) return;
    setError("");
    const done = await actions.update(input);
    if (!done) setError(t("taskSaveFailed"));
  }

  return (
    <form
      className="request-form task-edit"
      aria-label={t("taskEditTitle")}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <h3 className="task-screen__section">{t("taskEditTitle")}</h3>
      {canEdit && (
        <>
          <label className="request-form__field">
            <span className="request-form__label">{t("taskTitleLabel")}</span>
            <input
              className="request-input"
              value={draft.title}
              maxLength={taskLimits.titleMaxLength}
              aria-invalid={titleEmpty ? true : undefined}
              onChange={(event) =>
                setDraft({ ...draft, title: event.target.value })
              }
            />
          </label>
          <label className="request-form__field">
            <span className="request-form__label">
              {t("taskDescriptionLabel")}
            </span>
            <textarea
              className="request-form__body"
              rows={3}
              maxLength={taskLimits.descriptionMaxLength}
              value={draft.description}
              placeholder={t("taskDescriptionPlaceholder")}
              onChange={(event) =>
                setDraft({ ...draft, description: event.target.value })
              }
            />
          </label>
        </>
      )}
      {canReassign && (
        <div className="request-form__field">
          <span className="request-form__label">{t("taskAssigneeLabel")}</span>
          <button
            ref={pickRef}
            type="button"
            className="task-edit__person"
            aria-haspopup="dialog"
            onClick={() => setPicking(true)}
          >
            {personID ? (
              <Avatar
                name={nameOf(personID)}
                seed={personID}
                actorID={personID}
                size="xs"
              />
            ) : (
              <UserRound aria-hidden="true" />
            )}
            <span className="truncate">
              {personID
                ? personID === user.id
                  ? t("taskMe")
                  : nameOf(personID)
                : task.assignee.label
                  ? t(
                      task.assignee.kind === "department"
                        ? "taskQueueDepartment"
                        : "taskQueuePosition",
                      { label: task.assignee.label },
                    )
                  : t("taskNobody")}
            </span>
            <small>{t("taskChange")}</small>
          </button>
          {picking && (
            <MemberPicker
              anchorRef={pickRef}
              members={members}
              selfID={user.id}
              selected={personID}
              label={t("taskAssigneeLabel")}
              onPick={(id) => {
                if (id)
                  setDraft({
                    ...draft,
                    assignee: { kind: "person", actorID: id },
                  });
                setPicking(false);
              }}
              onDismiss={() => setPicking(false)}
            />
          )}
        </div>
      )}
      {canEdit && (
        <section className="request-form__section">
          <span className="request-form__label">{t("taskDueLabel")}</span>
          <div
            className="request-form__chips"
            role="radiogroup"
            aria-label={t("taskDueLabel")}
          >
            {task.due_at && (
              <Chip
                role="radio"
                aria-checked={due === "keep"}
                active={due === "keep"}
                onClick={() => setDue("keep")}
              >
                {formatTaskDue(new Date(task.due_at), now, locale)}
              </Chip>
            )}
            {presets.map((preset) => (
              <Chip
                key={preset.id}
                role="radio"
                aria-checked={due === preset.id}
                active={due === preset.id}
                onClick={() => setDue(preset.id)}
              >
                {formatTaskDue(preset.at, opened, locale)}
              </Chip>
            ))}
            <Chip
              role="radio"
              aria-checked={due === "custom"}
              active={due === "custom"}
              onClick={() => setDue("custom")}
            >
              {t("taskDueOther")}
            </Chip>
            <Chip
              role="radio"
              aria-checked={due === "none"}
              active={due === "none"}
              onClick={() => setDue("none")}
            >
              {t("taskDueNone")}
            </Chip>
          </div>
          {due === "custom" && (
            <input
              type="datetime-local"
              className="request-input"
              aria-label={t("taskDueCustomLabel")}
              value={customDue}
              step={60}
              onChange={(event) => setCustomDue(event.target.value)}
            />
          )}
          <div
            className={cx(
              "request-form__toggle",
              !remindAvailable && "request-form__toggle--disabled",
            )}
          >
            <span>
              <strong>{t("taskRemind")}</strong>
              <small>
                {remindAvailable
                  ? t("taskRemindShort")
                  : t("taskRemindNeedsDue")}
              </small>
            </span>
            <Switch
              checked={draft.remindBeforeDue && remindAvailable}
              disabled={!remindAvailable}
              onChange={(remindBeforeDue) =>
                setDraft({ ...draft, remindBeforeDue })
              }
              label={t("taskRemind")}
            />
          </div>
        </section>
      )}
      {error && <FormError message={error} />}
      <div className="task-edit__actions">
        <Button
          type="submit"
          size="sm"
          variant="primary"
          disabled={!input || titleEmpty}
          pending={actions.busy === "update"}
        >
          {t("save")}
        </Button>
      </div>
    </form>
  );
}

/** The checklist: tick, rename, assign, remove and add items. */
function TaskItemsEditor({
  message,
  members,
  actions,
  checkable,
}: {
  message: TaskMessage;
  members: ChatMember[];
  actions: TaskActions;
  checkable: string[];
}) {
  const { t } = useTranslation();
  const { user } = useMessenger();
  const task = message.task;
  const [adding, setAdding] = useState("");
  const [addWho, setAddWho] = useState<string | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const nameOf = (id: string) =>
    members.find((member) => member.actor_id === id)?.display_name ??
    t("taskSomeone");
  const full = task.items.length >= taskLimits.maxItems;

  async function add() {
    const text = adding.trim();
    if (!text) return;
    const done = await actions.addItem(text, addWho);
    if (done) {
      setAdding("");
      setAddWho(null);
    }
  }

  return (
    <section className="task-items-editor" aria-label={t("taskChecklist")}>
      <h3 className="task-screen__section">
        {t("taskChecklistProgress", {
          done: task.items_done,
          total: task.items.length,
        })}
      </h3>
      {task.items.map((item) => {
        const done = Boolean(item.done_at);
        return (
          <div
            key={item.id}
            className={cx("task-dialog__item", done && "task-item--done")}
          >
            <button
              type="button"
              role="checkbox"
              aria-checked={done}
              aria-label={item.text}
              className="task-check"
              disabled={!checkable.includes(item.id) || actions.busy === "item"}
              onClick={() => void actions.checkItem(item.id, !done)}
            >
              {done && <Check aria-hidden="true" />}
            </button>
            <input
              className="request-input"
              defaultValue={item.text}
              maxLength={taskLimits.itemMaxLength}
              aria-label={t("taskItemText")}
              onBlur={(event) => {
                const text = event.target.value.trim();
                if (text && text !== item.text)
                  void actions.changeItem(item.id, { text });
                else event.target.value = item.text;
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
            <button
              type="button"
              ref={(element) => {
                refs.current[item.id] = element;
              }}
              className={cx(
                "task-dialog__item-who",
                item.assignee_id && "task-dialog__item-who--set",
              )}
              aria-label={
                item.assignee_id
                  ? t("taskItemAssignee", { name: nameOf(item.assignee_id) })
                  : t("taskItemAssign")
              }
              onClick={() => setPicking(item.id)}
            >
              {item.assignee_id ? (
                <Avatar
                  name={nameOf(item.assignee_id)}
                  seed={item.assignee_id}
                  actorID={item.assignee_id}
                  size="xs"
                />
              ) : (
                <UserRound aria-hidden="true" />
              )}
            </button>
            <IconButton
              size="icon-sm"
              label={t("taskItemDelete", { text: item.text })}
              onClick={() => void actions.deleteItem(item.id)}
            >
              <Trash2 />
            </IconButton>
            {picking === item.id && (
              <MemberPicker
                anchorRef={{ current: refs.current[item.id] ?? null }}
                members={members}
                selfID={user.id}
                selected={item.assignee_id}
                label={t("taskItemAssign")}
                noneLabel={t("taskItemNobody")}
                onPick={(id) => {
                  setPicking(null);
                  if (id !== item.assignee_id)
                    void actions.changeItem(item.id, { assigneeID: id });
                }}
                onDismiss={() => setPicking(null)}
              />
            )}
          </div>
        );
      })}
      {!full && (
        <form
          className="task-dialog__item"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <span className="task-check task-check--static" aria-hidden="true" />
          <input
            className="request-input"
            value={adding}
            maxLength={taskLimits.itemMaxLength}
            placeholder={t("taskItemNew")}
            aria-label={t("taskItemNew")}
            onChange={(event) => setAdding(event.target.value)}
          />
          <button
            type="button"
            ref={(element) => {
              refs.current.new = element;
            }}
            className={cx(
              "task-dialog__item-who",
              addWho && "task-dialog__item-who--set",
            )}
            aria-label={
              addWho
                ? t("taskItemAssignee", { name: nameOf(addWho) })
                : t("taskItemAssign")
            }
            onClick={() => setPicking("new")}
          >
            {addWho ? (
              <Avatar
                name={nameOf(addWho)}
                seed={addWho}
                actorID={addWho}
                size="xs"
              />
            ) : (
              <UserRound aria-hidden="true" />
            )}
          </button>
          <IconButton
            size="icon-sm"
            type="submit"
            label={t("taskAddItem")}
            disabled={!adding.trim() || actions.busy === "item"}
          >
            <Plus />
          </IconButton>
          {picking === "new" && (
            <MemberPicker
              anchorRef={{ current: refs.current.new ?? null }}
              members={members}
              selfID={user.id}
              selected={addWho}
              label={t("taskItemAssign")}
              noneLabel={t("taskItemNobody")}
              onPick={(id) => {
                setAddWho(id);
                setPicking(null);
              }}
              onDismiss={() => setPicking(null)}
            />
          )}
        </form>
      )}
    </section>
  );
}
