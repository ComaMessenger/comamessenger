import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Keyboard, Pressable, TextInput, View } from "react-native";
import { Plus, UserRound } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  emptyTaskDraft,
  formatTaskDue,
  remindBeforeDueAvailable,
  taskAssigneeSegments,
  taskCandidateIDs,
  taskDraftProblem,
  taskLimits,
  toCreateTaskInput,
  type ChatMember,
  type TaskAssigneeSegment,
  type TaskDraft,
  type TaskDraftItem,
} from "@comamessenger/core";
import { useStore } from "zustand";
import { useTheme } from "@/lib/theme";
import { accountValues } from "@/lib/database";
import { useSignedIn } from "@/session/SessionProvider";
import { useMessenger } from "@/messenger/MessengerProvider";
import { Avatar } from "@/ui/Avatar";
import { BottomSheet } from "@/ui/BottomSheet";
import { Text, maxTextScale } from "@/ui/Text";
import { useNow } from "@/scheduled/clock";
import { calendarLocale } from "@/requests/locale";
import {
  SectionLabel,
  Segmented,
  ToggleRow,
  WideButton,
} from "@/requests/parts";
import {
  DueField,
  GroupChoice,
  MemberChoice,
  PersonChips,
  fieldStyles,
  taskPeople,
} from "./fields";
import { useOrg } from "@/org/useOrg";
import { taskFailKey } from "./format";
import { sendTask } from "./outbox";
import { TaskCheck } from "./parts";

/** The form kept on the device until it is sent, per chat. */
type StoredDraft = Omit<TaskDraft, "dueAt"> & {
  dueAt: string | null;
  customDue?: boolean;
};

const draftKey = (chatID: string) => `task_draft:${chatID}`;

function toStored(draft: TaskDraft, customDue: boolean): StoredDraft {
  return {
    ...draft,
    dueAt: draft.dueAt ? draft.dueAt.toISOString() : null,
    customDue,
  };
}

function fromStored(value: StoredDraft | null): {
  draft: TaskDraft;
  customDue: boolean;
} | null {
  if (!value || typeof value.title !== "string") return null;
  const { customDue, ...rest } = value;
  return {
    draft: {
      ...emptyTaskDraft(),
      ...rest,
      dueAt: rest.dueAt ? new Date(rest.dueAt) : null,
    },
    customDue: Boolean(customDue),
  };
}

/** Nothing typed worth keeping. */
function blank(draft: TaskDraft) {
  return (
    !draft.title.trim() &&
    !draft.description.trim() &&
    !draft.items.some((item) => item.text.trim())
  );
}

const newItem = (): TaskDraftItem => ({
  key: crypto.randomUUID(),
  text: "",
  assigneeID: null,
});

/** The prototype opens the checklist with two empty lines. */
function withRows(draft: TaskDraft): TaskDraft {
  return draft.items.length
    ? draft
    : { ...draft, items: [newItem(), newItem()] };
}

function problemText(
  t: (key: string, values?: Record<string, unknown>) => string,
  problem: NonNullable<ReturnType<typeof taskDraftProblem>>,
): string {
  switch (problem.field) {
    case "title":
      return problem.reason === "empty"
        ? t("taskErrorTitle")
        : t("taskErrorTitleTooLong");
    case "description":
      return t("taskErrorDescriptionTooLong");
    case "assignee":
      return problem.reason === "empty"
        ? t("taskErrorAssignee")
        : problem.reason === "audienceEmpty"
          ? t("taskErrorAudienceEmpty")
          : t("taskErrorAudienceTooMany");
    case "dueAt":
      return problem.reason === "tooFar"
        ? t("taskErrorDueTooFar")
        : t("taskErrorDuePast");
    case "items":
      return problem.reason === "tooMany"
        ? t("taskErrorItemsTooMany", { max: taskLimits.maxItems })
        : t("taskErrorItemTooLong", { index: (problem.index ?? 0) + 1 });
  }
}

export type TaskSource = {
  messageID: string;
  authorName: string;
  /** The first characters of the message, for «из сообщения …: «…»». */
  excerpt: string;
  /** The title the form starts with (taskDraftFromMessage). */
  draft: TaskDraft;
};

type Picking = { kind: "assignee" } | { kind: "item"; key: string } | null;

/**
 * «Новая задача» from «+» or «Сделать задачей», as on phone A of the
 * prototype: what to do, a description, one responsible person (or, with
 * the right, a department or position as a queue), the due date, a
 * checklist whose items may have their own people, the reminder an hour
 * before. Kept on the device until sent; sending goes through the task
 * queue, so a task written offline goes once the network is back.
 */
export function TaskSheet({
  visible,
  chatID,
  members,
  source,
  onClose,
  onNotice,
}: {
  visible: boolean;
  chatID: string;
  members: ChatMember[];
  /** «Сделать задачей»: the message the task comes from. */
  source?: TaskSource | null;
  onClose(): void;
  onNotice(text: string): void;
}) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const { api, user } = useSignedIn();
  const { store } = useMessenger();
  const features = useStore(store, (state) => state.features);
  const locale = calendarLocale(i18n.language);
  const now = useNow(30_000, visible);
  const [draft, setDraft] = useState<TaskDraft>(() =>
    withRows(emptyTaskDraft()),
  );
  const [customDue, setCustomDue] = useState(false);
  const [sending, setSending] = useState(false);
  const [tried, setTried] = useState(false);
  const [picking, setPicking] = useState<Picking>(null);
  const loaded = useRef<string | null>(null);

  // The form of this chat comes back as it was left; «Сделать задачей»
  // starts from the message instead.
  useEffect(() => {
    if (!visible) {
      loaded.current = null;
      setPicking(null);
      return;
    }
    const key = `${chatID}:${source?.messageID ?? ""}`;
    if (loaded.current === key) return;
    loaded.current = key;
    setTried(false);
    if (source) {
      setDraft(withRows(source.draft));
      setCustomDue(false);
      return;
    }
    void accountValues
      .get<StoredDraft>(draftKey(chatID))
      .then((stored) => {
        const restored = fromStored(stored);
        if (!restored || restored.draft.sourceMessageID) return;
        setDraft(withRows(restored.draft));
        setCustomDue(restored.customDue);
      })
      .catch(() => undefined);
  }, [chatID, source, visible]);

  function update(patch: Partial<TaskDraft>, custom = customDue) {
    setDraft((current) => {
      const next = { ...current, ...patch };
      // A task from a message is not kept: the message stays where it is.
      if (!next.sourceMessageID)
        void accountValues
          .set(draftKey(chatID), blank(next) ? null : toStored(next, custom))
          .catch(() => undefined);
      return next;
    });
  }

  const segments = taskAssigneeSegments(user, features, undefined);
  const groups = segments.length > 1;
  // The org structure of wave 2 (GET /org with ETag, cached for an offline start).
  const org = useOrg();
  const structure = groups ? org.structure : null;
  const shownSegments: TaskAssigneeSegment[] = taskAssigneeSegments(
    user,
    features,
    structure,
  );
  const candidates = useMemo(
    () => taskCandidateIDs(draft.assignee, members, structure),
    [draft.assignee, members, structure],
  );
  const problem = taskDraftProblem(
    draft,
    now,
    draft.assignee.kind === "person" ? undefined : candidates.length,
  );
  const remindPossible = remindBeforeDueAvailable(draft.dueAt, now);
  const people = useMemo(() => taskPeople(members), [members]);
  const nameOf = (id: string) =>
    people.find((member) => member.actor_id === id)?.display_name ??
    t("taskSomeone");

  function setItem(key: string, patch: Partial<TaskDraftItem>) {
    update({
      items: draft.items.map((item) =>
        item.key === key ? { ...item, ...patch } : item,
      ),
    });
  }

  async function send() {
    setTried(true);
    if (problem || sending) return;
    setSending(true);
    const sentAt = new Date();
    const assignee = draft.assignee;
    try {
      const result = await sendTask(api, store, chatID, (clientMsgID) =>
        toCreateTaskInput(draft, clientMsgID, sentAt),
      );
      if (result.kind === "refused") {
        Alert.alert(t("taskSendFailed"), t(taskFailKey(result.error)));
        return;
      }
      if (!draft.sourceMessageID)
        await accountValues.set(draftKey(chatID), null).catch(() => undefined);
      setDraft(withRows(emptyTaskDraft()));
      setCustomDue(false);
      setTried(false);
      onClose();
      onNotice(
        result.kind === "queued"
          ? t("taskQueued")
          : assignee.kind !== "person"
            ? t("taskCreatedQueue")
            : assignee.actorID === user.id
              ? t("taskCreatedMine")
              : t("taskCreated"),
      );
    } finally {
      setSending(false);
    }
  }

  const pickedItem =
    picking?.kind === "item"
      ? draft.items.find((item) => item.key === picking.key)
      : undefined;

  return (
    <BottomSheet
      visible={visible}
      title={
        picking?.kind === "assignee"
          ? t("taskAssigneeLabel")
          : picking?.kind === "item"
            ? t("taskItemAssign")
            : t("taskDialogTitle")
      }
      action={
        picking
          ? { label: t("back"), onPress: () => setPicking(null) }
          : undefined
      }
      onClose={onClose}
      testID="task-sheet"
    >
      {picking?.kind === "assignee" ? (
        <MemberChoice
          testID="task-assignee-choice"
          members={members}
          value={
            draft.assignee.kind === "person" ? draft.assignee.actorID : null
          }
          onPick={(actorID) => {
            if (actorID) update({ assignee: { kind: "person", actorID } });
            setPicking(null);
          }}
        />
      ) : picking?.kind === "item" ? (
        <MemberChoice
          testID="task-item-choice"
          members={members}
          value={pickedItem?.assigneeID ?? null}
          none={t("taskItemNobody")}
          onPick={(actorID) => {
            setItem(picking.key, { assigneeID: actorID });
            setPicking(null);
          }}
        />
      ) : (
        <>
          {source ? (
            <View
              style={[styles.source, { borderLeftColor: theme.borderStrong }]}
            >
              <Text tone="muted" size={12.5} numberOfLines={2}>
                {t("taskSource", {
                  name: source.authorName,
                  excerpt: source.excerpt,
                })}
              </Text>
            </View>
          ) : null}
          <TextInput
            testID="task-title-input"
            value={draft.title}
            onChangeText={(title) => update({ title })}
            placeholder={t("taskTitleLabel")}
            placeholderTextColor={theme.muted}
            accessibilityLabel={t("taskTitleLabel")}
            selectionColor={theme.primary}
            maxLength={taskLimits.titleMaxLength + 20}
            maxFontSizeMultiplier={maxTextScale}
            style={[
              fieldStyles.input,
              fieldStyles.title,
              {
                color: theme.foreground,
                backgroundColor: theme.surface,
                borderColor:
                  tried && problem?.field === "title"
                    ? theme.danger
                    : theme.borderStrong,
              },
            ]}
          />
          <TextInput
            testID="task-description-input"
            value={draft.description}
            onChangeText={(description) => update({ description })}
            placeholder={t("taskDescriptionLabel")}
            placeholderTextColor={theme.muted}
            accessibilityLabel={t("taskDescriptionLabel")}
            selectionColor={theme.primary}
            multiline
            maxFontSizeMultiplier={maxTextScale}
            style={[
              fieldStyles.input,
              fieldStyles.description,
              styles.gap,
              {
                color: theme.foreground,
                backgroundColor: theme.surface,
                borderColor:
                  tried && problem?.field === "description"
                    ? theme.danger
                    : theme.borderStrong,
              },
            ]}
          />
          {tried &&
          (problem?.field === "title" || problem?.field === "description") ? (
            <Text tone="danger" size={13} style={fieldStyles.error}>
              {problemText(t, problem)}
            </Text>
          ) : null}

          <SectionLabel>{t("taskAssigneeLabel")}</SectionLabel>
          {shownSegments.length > 1 ? (
            <View style={styles.segments}>
              <Segmented
                testID="task-assignee-kind"
                value={draft.assignee.kind}
                options={shownSegments.map((segment) => ({
                  value: segment,
                  label: t(
                    segment === "person"
                      ? "taskAssigneePerson"
                      : segment === "department"
                        ? "taskAssigneeDepartment"
                        : "taskAssigneePosition",
                  ),
                }))}
                onChange={(kind) => {
                  // The list of departments or positions goes under the
                  // keyboard otherwise.
                  Keyboard.dismiss();
                  update({
                    assignee:
                      kind === "person"
                        ? { kind, actorID: null }
                        : kind === "department"
                          ? { kind, departmentID: null }
                          : { kind, positionID: null },
                  });
                }}
              />
            </View>
          ) : null}
          {draft.assignee.kind === "person" ? (
            <PersonChips
              chatID={chatID}
              members={members}
              value={draft.assignee.actorID}
              testID="task-person"
              onChange={(actorID) =>
                update({ assignee: { kind: "person", actorID } })
              }
              onMore={() => setPicking({ kind: "assignee" })}
            />
          ) : structure ? (
            <>
              <Text tone="muted" size={13}>
                {t("taskQueueExplain")}
              </Text>
              <GroupChoice
                kind={draft.assignee.kind}
                assignee={draft.assignee}
                structure={structure}
                members={members}
                onChange={(assignee) => update({ assignee })}
              />
              {(
                draft.assignee.kind === "department"
                  ? draft.assignee.departmentID
                  : draft.assignee.positionID
              ) ? (
                <Text
                  testID="task-queue-who"
                  tone={candidates.length ? "muted" : "danger"}
                  size={13}
                  style={fieldStyles.caption}
                >
                  {t("taskQueueWho", { count: candidates.length })}
                </Text>
              ) : null}
            </>
          ) : (
            <Text tone="muted" size={13}>
              {t("taskOrgLoading")}
            </Text>
          )}
          {tried && problem?.field === "assignee" ? (
            <Text tone="danger" size={13} style={fieldStyles.error}>
              {problemText(t, problem)}
            </Text>
          ) : null}

          <SectionLabel>{t("taskDueLabel")}</SectionLabel>
          <DueField
            testID="task-due"
            value={draft.dueAt}
            custom={customDue}
            now={now}
            onChange={(dueAt, custom) => {
              setCustomDue(custom);
              update({ dueAt }, custom);
            }}
          />
          {problem?.field === "dueAt" && (tried || customDue) ? (
            <Text tone="danger" size={13} style={fieldStyles.error}>
              {problemText(t, problem)}
            </Text>
          ) : null}

          <SectionLabel>{t("taskChecklistLabel")}</SectionLabel>
          {draft.items.map((item, index) => (
            <View key={item.key} style={fieldStyles.item}>
              <TaskCheck checked={false} size={20} label="" disabled />
              <TextInput
                testID={`task-item-input-${index}`}
                value={item.text}
                onChangeText={(text) => setItem(item.key, { text })}
                placeholder={t("taskItemPlaceholder", { index: index + 1 })}
                placeholderTextColor={theme.muted}
                accessibilityLabel={t("taskItemPlaceholder", {
                  index: index + 1,
                })}
                selectionColor={theme.primary}
                maxFontSizeMultiplier={maxTextScale}
                style={[
                  fieldStyles.itemInput,
                  {
                    color: theme.foreground,
                    backgroundColor: theme.surface,
                    borderColor:
                      tried &&
                      problem?.field === "items" &&
                      problem.index === index
                        ? theme.danger
                        : theme.borderStrong,
                  },
                ]}
              />
              <Pressable
                testID={`task-item-who-${index}`}
                accessibilityRole="button"
                accessibilityLabel={
                  item.assigneeID
                    ? t("taskItemAssignee", { name: nameOf(item.assigneeID) })
                    : t("taskItemAssign")
                }
                hitSlop={4}
                onPress={() => setPicking({ kind: "item", key: item.key })}
                style={fieldStyles.itemWho}
              >
                {item.assigneeID ? (
                  <Avatar
                    name={nameOf(item.assigneeID)}
                    seed={item.assigneeID}
                    size={26}
                    actorID={item.assigneeID}
                    avatarVersion={
                      people.find(
                        (member) => member.actor_id === item.assigneeID,
                      )?.avatar_version
                    }
                  />
                ) : (
                  <UserRound size={18} color={theme.muted} />
                )}
              </Pressable>
            </View>
          ))}
          {draft.items.length < taskLimits.maxItems ? (
            <Pressable
              testID="task-item-add"
              accessibilityRole="button"
              onPress={() => update({ items: [...draft.items, newItem()] })}
              style={fieldStyles.add}
            >
              <Plus size={16} color={theme.primary} />
              <Text tone="primary" weight="semibold" size={14}>
                {t("taskAddItem")}
              </Text>
            </Pressable>
          ) : null}
          {tried && problem?.field === "items" ? (
            <Text tone="danger" size={13} style={fieldStyles.error}>
              {problemText(t, problem)}
            </Text>
          ) : null}

          <ToggleRow
            testID="task-remind"
            label={t("taskRemind")}
            hint={
              remindPossible && draft.dueAt
                ? t("taskRemindHint", {
                    when: formatTaskDue(
                      new Date(draft.dueAt.getTime() - taskLimits.remindLeadMs),
                      now,
                      locale,
                    ),
                  })
                : t("taskRemindNeedsDue")
            }
            value={draft.remindBeforeDue && remindPossible}
            disabled={!remindPossible}
            onChange={(remindBeforeDue) => update({ remindBeforeDue })}
          />

          <WideButton
            testID="task-create"
            label={t("taskCreate")}
            pending={sending}
            disabled={tried && Boolean(problem)}
            onPress={() => void send()}
            style={styles.send}
          />
        </>
      )}
    </BottomSheet>
  );
}

const styles = {
  source: { borderLeftWidth: 2, paddingLeft: 7, marginBottom: 8 },
  gap: { marginTop: 8 },
  segments: { marginBottom: 8 },
  send: { marginTop: 14 },
} as const;
