import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, UserRound, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  buildOrgTree,
  emptyTaskDraft,
  flattenOrgTree,
  formatTaskDue,
  fromLocalInputValue,
  remindBeforeDueAvailable,
  taskCandidateIDs,
  taskDraftProblem,
  taskDuePresets,
  taskLimits,
  taskSignature,
  toCreateTaskInput,
  toLocalInputValue,
  type ChatMember,
  type CreateTaskRequest,
  type Message,
  type OrgStructure,
  type TaskAssigneeSegment,
  type TaskDraft,
  type TaskDraftAssignee,
  type TaskDraftProblem,
  type TaskDuePresetID,
} from "@comamessenger/core";
import {
  Avatar,
  Button,
  Chip,
  Dialog,
  FormError,
  IconButton,
  Segmented,
  Switch,
  cx,
} from "../ui";
import { calendarLocale } from "../requests/format";
import { taskErrorText } from "./format";
import { MemberPicker } from "./MemberPicker";

export type DueChoice = "none" | TaskDuePresetID | "custom";

/** What the form remembers between openings, per reader and chat. */
type StoredDraft = Omit<TaskDraft, "dueAt"> & {
  due: DueChoice;
  customDue: string;
};

const draftKey = (userID: string, chatID: string, source: string | null) =>
  `coma-task-draft:${userID}:${chatID}:${source ?? "new"}`;

function readDraft(key: string): StoredDraft | null {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as StoredDraft) : null;
  } catch {
    return null;
  }
}

export function taskProblemText(
  problem: TaskDraftProblem,
  t: (key: string, values?: Record<string, unknown>) => string,
): string {
  switch (problem.field) {
    case "title":
      return t(
        problem.reason === "empty" ? "taskErrorTitle" : "taskErrorTitleTooLong",
      );
    case "description":
      return t("taskErrorDescriptionTooLong");
    case "assignee":
      return t(
        problem.reason === "empty"
          ? "taskErrorAssignee"
          : problem.reason === "audienceEmpty"
            ? "taskErrorAudienceEmpty"
            : "taskErrorAudienceTooMany",
      );
    case "dueAt":
      return t(problem.reason === "past" ? "taskErrorDuePast" : "taskErrorDueTooFar");
    case "items":
      return problem.reason === "tooMany"
        ? t("taskErrorItemsTooMany", { max: taskLimits.maxItems })
        : t("taskErrorItemTooLong", { index: (problem.index ?? 0) + 1 });
  }
}

let itemKey = 0;
const newItem = () => ({
  key: `item-${(itemKey += 1)}`,
  text: "",
  assigneeID: null,
});

/**
 * New task: what to do, a description, one responsible person (or,
 * with the right, the queue of a department or a position), a due date,
 * a checklist whose items may have their own people, and the reminder an
 * hour before the due date. From Make a task the title comes from the
 * message and the card links back to it. The form keeps its draft for the
 * session until the task is created; a retry reuses the same client id.
 */
export function TaskDialog({
  chatID,
  userID,
  members,
  initial,
  source,
  segments = ["person"],
  structure,
  recentIDs = [],
  createTask,
  onSent,
  onClose,
}: {
  chatID: string;
  userID: string;
  members: ChatMember[];
  /** A prefilled form (Make a task); a stored or empty one otherwise. */
  initial?: TaskDraft;
  /** from a message by {author}: “…” above the form. */
  source?: { authorName: string; excerpt: string } | null;
  segments?: TaskAssigneeSegment[];
  structure?: OrgStructure | null;
  /** People of the chat who wrote last: the first chips of Responsible. */
  recentIDs?: string[];
  createTask(chatID: string, input: CreateTaskRequest): Promise<Message>;
  onSent(message: Message): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const locale = calendarLocale();
  const [opened] = useState(() => new Date());
  const duePresets = useMemo(() => taskDuePresets(opened), [opened]);
  const key = draftKey(userID, chatID, initial?.sourceMessageID ?? null);
  const stored = useMemo(() => readDraft(key), [key]);
  const [draft, setDraft] = useState<Omit<TaskDraft, "dueAt">>(() => {
    if (stored) {
      const { due: _due, customDue: _custom, ...rest } = stored;
      return rest;
    }
    const { dueAt: _ignored, ...rest } = initial ?? emptyTaskDraft();
    return rest;
  });
  const [due, setDue] = useState<DueChoice>(() => {
    const value = stored?.due ?? "none";
    return value === "none" ||
      value === "custom" ||
      duePresets.some((preset) => preset.id === value)
      ? value
      : "none";
  });
  const [customDue, setCustomDue] = useState(
    () =>
      stored?.customDue ||
      toLocalInputValue(new Date(opened.getTime() + 24 * 60 * 60_000)),
  );
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [picking, setPicking] = useState<"assignee" | number | null>(null);
  const moreRef = useRef<HTMLSpanElement>(null);
  const itemRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const titleRef = useRef<HTMLInputElement>(null);
  // A retry of the same task reuses its id: the server returns the message
  // it already made instead of a second one.
  const sent = useRef<{ signature: string; id: string } | null>(null);

  useEffect(() => {
    try {
      sessionStorage.setItem(
        key,
        JSON.stringify({ ...draft, due, customDue } satisfies StoredDraft),
      );
    } catch {
      // Private mode: the draft lives as long as the dialog.
    }
  }, [customDue, draft, due, key]);

  const people = useMemo(
    () => members.filter((member) => member.type === "user"),
    [members],
  );
  const nameOf = (id: string) =>
    people.find((member) => member.actor_id === id)?.display_name ?? "";
  // Me first, then whoever wrote last, then the rest; at most six chips.
  const chipIDs = useMemo(() => {
    const ids = [userID];
    for (const id of [...recentIDs, ...people.map((member) => member.actor_id)])
      if (!ids.includes(id) && people.some((member) => member.actor_id === id))
        ids.push(id);
    return ids.slice(0, 6);
  }, [people, recentIDs, userID]);
  const assignee = draft.assignee;
  const personID = assignee.kind === "person" ? assignee.actorID : null;
  const shownChips =
    personID && !chipIDs.includes(personID) ? [...chipIDs, personID] : chipIDs;

  const dueAt =
    due === "none"
      ? null
      : due === "custom"
        ? fromLocalInputValue(customDue)
        : (duePresets.find((preset) => preset.id === due)?.at ?? null);
  const now = new Date();
  const full: TaskDraft = { ...draft, dueAt };
  const candidates = taskCandidateIDs(assignee, members, structure);
  const problem =
    due === "custom" && !dueAt
      ? ({ field: "dueAt", reason: "past" } as const)
      : taskDraftProblem(
          full,
          now,
          assignee.kind === "person" || !structure ? undefined : candidates.length,
        );
  const remindAvailable = remindBeforeDueAvailable(dueAt, now);

  function update(patch: Partial<Omit<TaskDraft, "dueAt">>) {
    setDraft((current) => ({ ...current, ...patch }));
    setError("");
  }
  function setAssignee(next: TaskDraftAssignee) {
    update({ assignee: next });
  }
  function updateItem(index: number, patch: Partial<TaskDraft["items"][number]>) {
    update({
      items: draft.items.map((item, at) =>
        at === index ? { ...item, ...patch } : item,
      ),
    });
  }

  async function submit() {
    setTouched(true);
    if (problem) {
      if (problem.field === "title") titleRef.current?.focus();
      return;
    }
    const at = new Date();
    const probe = toCreateTaskInput(full, "", at);
    const signature = taskSignature(probe);
    if (sent.current?.signature !== signature)
      sent.current = { signature, id: crypto.randomUUID() };
    setPending(true);
    setError("");
    try {
      const message = await createTask(
        chatID,
        toCreateTaskInput(full, sent.current.id, at),
      );
      try {
        sessionStorage.removeItem(key);
      } catch {
        // Nothing stored.
      }
      onSent(message);
    } catch (cause) {
      setError(taskErrorText(cause));
    } finally {
      setPending(false);
    }
  }

  const shown = touched && problem ? taskProblemText(problem, t) : "";
  const departments = structure
    ? flattenOrgTree(buildOrgTree(structure), "all")
    : [];
  const positions = structure?.positions ?? [];

  return (
    <Dialog
      title={t("taskDialogTitle")}
      onClose={onClose}
      sheet
      className="request-dialog task-dialog"
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            {t("cancel")}
          </Button>
          <Button
            variant="primary"
            pending={pending}
            disabled={touched && Boolean(problem)}
            onClick={() => void submit()}
          >
            {t("taskCreate")}
          </Button>
        </>
      }
    >
      <form
        className="request-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {source && (
          <div className="task-card__source task-dialog__source">
            {t("taskSource", {
              name: source.authorName,
              excerpt: source.excerpt,
            })}
          </div>
        )}
        <label className="request-form__field">
          <span className="request-form__label">{t("taskTitleLabel")}</span>
          <input
            ref={titleRef}
            className="request-input task-dialog__title"
            autoFocus
            maxLength={taskLimits.titleMaxLength + 20}
            value={draft.title}
            placeholder={t("taskTitlePlaceholder")}
            aria-invalid={
              touched && problem?.field === "title" ? true : undefined
            }
            onChange={(event) => update({ title: event.target.value })}
          />
        </label>
        <label className="request-form__field">
          <span className="request-form__label">
            {t("taskDescriptionLabel")}
          </span>
          <textarea
            className="request-form__body"
            rows={2}
            maxLength={taskLimits.descriptionMaxLength + 20}
            value={draft.description}
            placeholder={t("taskDescriptionPlaceholder")}
            aria-invalid={
              touched && problem?.field === "description" ? true : undefined
            }
            onChange={(event) => update({ description: event.target.value })}
          />
        </label>

        <section className="request-form__section">
          <span className="request-form__label">{t("taskAssigneeLabel")}</span>
          {segments.length > 1 && (
            <Segmented
              label={t("taskAssigneeLabel")}
              value={assignee.kind}
              onChange={(kind) =>
                setAssignee(
                  kind === "person"
                    ? { kind, actorID: null }
                    : kind === "department"
                      ? { kind, departmentID: null }
                      : { kind, positionID: null },
                )
              }
              items={segments.map((id) => ({
                id,
                label: t(
                  id === "person"
                    ? "taskAssigneePerson"
                    : id === "department"
                      ? "taskAssigneeDepartment"
                      : "taskAssigneePosition",
                ),
              }))}
            />
          )}
          {assignee.kind === "person" ? (
            <div
              className="request-form__chips"
              role="radiogroup"
              aria-label={t("taskAssigneeLabel")}
            >
              {shownChips.map((id) => (
                <Chip
                  key={id}
                  role="radio"
                  aria-checked={personID === id}
                  active={personID === id}
                  className="task-dialog__person"
                  onClick={() => setAssignee({ kind: "person", actorID: id })}
                >
                  <Avatar
                    name={nameOf(id)}
                    seed={id}
                    actorID={id}
                    avatarVersion={
                      people.find((member) => member.actor_id === id)
                        ?.avatar_version
                    }
                    size="xs"
                  />
                  {id === userID ? t("taskMe") : nameOf(id)}
                </Chip>
              ))}
              {people.length > chipIDs.length && (
                <span ref={moreRef} className="task-dialog__more">
                  <Chip
                    aria-haspopup="dialog"
                    onClick={() => setPicking("assignee")}
                  >
                    {t("taskMorePeople")}
                  </Chip>
                </span>
              )}
            </div>
          ) : (
            <label className="request-form__field">
              <span className="visually-hidden">
                {t(
                  assignee.kind === "department"
                    ? "taskAssigneeDepartment"
                    : "taskAssigneePosition",
                )}
              </span>
              <select
                className="request-input"
                value={
                  (assignee.kind === "department"
                    ? assignee.departmentID
                    : assignee.positionID) ?? ""
                }
                onChange={(event) => {
                  const value = event.target.value || null;
                  setAssignee(
                    assignee.kind === "department"
                      ? { kind: "department", departmentID: value }
                      : { kind: "position", positionID: value },
                  );
                }}
              >
                <option value="">
                  {t(
                    assignee.kind === "department"
                      ? "taskChooseDepartment"
                      : "taskChoosePosition",
                  )}
                </option>
                {assignee.kind === "department"
                  ? departments.map((row) => (
                      <option
                        key={row.node.department.id}
                        value={row.node.department.id}
                      >
                        {`${"  ".repeat(row.depth)}${row.node.department.name}`}
                      </option>
                    ))
                  : positions.map((position) => (
                      <option key={position.id} value={position.id}>
                        {position.name}
                      </option>
                    ))}
              </select>
              <span className="request-form__hint">
                {(assignee.kind === "department"
                  ? assignee.departmentID
                  : assignee.positionID)
                  ? t("taskQueueWho", { count: candidates.length })
                  : t("taskQueueExplain")}
              </span>
            </label>
          )}
        </section>

        <section className="request-form__section">
          <span className="request-form__label">{t("taskDueLabel")}</span>
          <div
            className="request-form__chips"
            role="radiogroup"
            aria-label={t("taskDueLabel")}
          >
            {duePresets.map((preset) => (
              <Chip
                key={preset.id}
                role="radio"
                aria-checked={due === preset.id}
                active={due === preset.id}
                onClick={() => {
                  setDue(preset.id);
                  setError("");
                }}
              >
                {formatTaskDue(preset.at, opened, locale)}
              </Chip>
            ))}
            <Chip
              role="radio"
              aria-checked={due === "custom"}
              active={due === "custom"}
              onClick={() => {
                setDue("custom");
                setError("");
              }}
            >
              {t("taskDueOther")}
            </Chip>
            <Chip
              role="radio"
              aria-checked={due === "none"}
              active={due === "none"}
              onClick={() => {
                setDue("none");
                setError("");
              }}
            >
              {t("taskDueNone")}
            </Chip>
          </div>
          {due === "custom" && (
            <label className="request-form__field request-form__date">
              <span className="request-form__label">
                {t("taskDueCustomLabel")}
              </span>
              <input
                type="datetime-local"
                className="request-input"
                value={customDue}
                min={toLocalInputValue(
                  new Date(opened.getTime() + taskLimits.dueMinLeadMs),
                )}
                max={toLocalInputValue(
                  new Date(opened.getTime() + taskLimits.dueHorizonMs - 60_000),
                )}
                step={60}
                aria-invalid={
                  touched && problem?.field === "dueAt" ? true : undefined
                }
                onChange={(event) => {
                  setCustomDue(event.target.value);
                  setError("");
                }}
              />
            </label>
          )}
        </section>

        <section className="request-form__section">
          <span className="request-form__label">{t("taskChecklistLabel")}</span>
          {draft.items.length > 0 && (
            <div className="task-dialog__items">
              {draft.items.map((item, index) => (
                <div className="task-dialog__item" key={item.key}>
                  <span className="task-check task-check--static" aria-hidden="true" />
                  <input
                    className="request-input"
                    value={item.text}
                    maxLength={taskLimits.itemMaxLength + 20}
                    placeholder={t("taskItemPlaceholder", { index: index + 1 })}
                    aria-label={t("taskItemPlaceholder", { index: index + 1 })}
                    aria-invalid={
                      touched &&
                      problem?.field === "items" &&
                      problem.index === index
                        ? true
                        : undefined
                    }
                    onChange={(event) =>
                      updateItem(index, { text: event.target.value })
                    }
                    onKeyDown={(event) => {
                      if (
                        event.key === "Enter" &&
                        draft.items.length < taskLimits.maxItems
                      ) {
                        event.preventDefault();
                        update({ items: [...draft.items, newItem()] });
                      }
                    }}
                  />
                  <button
                    type="button"
                    ref={(element) => {
                      itemRefs.current[item.key] = element;
                    }}
                    className={cx(
                      "task-dialog__item-who",
                      item.assigneeID && "task-dialog__item-who--set",
                    )}
                    aria-label={
                      item.assigneeID
                        ? t("taskItemAssignee", { name: nameOf(item.assigneeID) })
                        : t("taskItemAssign")
                    }
                    title={
                      item.assigneeID ? nameOf(item.assigneeID) : t("taskItemAssign")
                    }
                    onClick={() => setPicking(index)}
                  >
                    {item.assigneeID ? (
                      <Avatar
                        name={nameOf(item.assigneeID)}
                        seed={item.assigneeID}
                        actorID={item.assigneeID}
                        size="xs"
                      />
                    ) : (
                      <UserRound aria-hidden="true" />
                    )}
                  </button>
                  <IconButton
                    size="icon-sm"
                    label={t("taskItemRemove", { index: index + 1 })}
                    onClick={() =>
                      update({
                        items: draft.items.filter((_item, at) => at !== index),
                      })
                    }
                  >
                    <X />
                  </IconButton>
                </div>
              ))}
            </div>
          )}
          {draft.items.length < taskLimits.maxItems && (
            <Button
              variant="ghost"
              size="sm"
              className="request-form__add"
              onClick={() => update({ items: [...draft.items, newItem()] })}
            >
              <Plus aria-hidden="true" />
              {t("taskAddItem")}
            </Button>
          )}
        </section>

        <div
          className={cx(
            "request-form__toggle",
            !remindAvailable && "request-form__toggle--disabled",
          )}
        >
          <span>
            <strong>{t("taskRemind")}</strong>
            <small>
              {remindAvailable && dueAt
                ? t("taskRemindHint", {
                    when: formatTaskDue(
                      new Date(dueAt.getTime() - taskLimits.remindLeadMs),
                      now,
                      locale,
                    ),
                  })
                : t("taskRemindNeedsDue")}
            </small>
          </span>
          <Switch
            checked={draft.remindBeforeDue && remindAvailable}
            disabled={!remindAvailable}
            onChange={(remindBeforeDue) => update({ remindBeforeDue })}
            label={t("taskRemind")}
          />
        </div>
        {shown && <FormError message={shown} />}
        {error && <FormError message={error} />}
        <button type="submit" hidden />
      </form>
      {picking === "assignee" && (
        <MemberPicker
          anchorRef={moreRef}
          members={members}
          selfID={userID}
          selected={personID}
          label={t("taskAssigneeLabel")}
          onPick={(id) => {
            if (id) setAssignee({ kind: "person", actorID: id });
            setPicking(null);
          }}
          onDismiss={() => setPicking(null)}
        />
      )}
      {typeof picking === "number" && draft.items[picking] && (
        <MemberPicker
          anchorRef={{
            current: itemRefs.current[draft.items[picking]!.key] ?? null,
          }}
          members={members}
          selfID={userID}
          selected={draft.items[picking]!.assigneeID}
          label={t("taskItemAssign")}
          noneLabel={t("taskItemNobody")}
          onPick={(id) => {
            updateItem(picking, { assigneeID: id });
            setPicking(null);
          }}
          onDismiss={() => setPicking(null)}
        />
      )}
    </Dialog>
  );
}
