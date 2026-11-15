import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { router } from "expo-router";
import {
  ArrowUpRight,
  MessagesSquare,
  Plus,
  Trash2,
  UserRound,
} from "lucide-react-native";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import {
  newerTask,
  remindBeforeDueAvailable,
  taskCardView,
  taskDraftFromTask,
  taskDuePresets,
  taskKeys,
  taskLimits,
  taskUpdateInput,
  type ChatMember,
  type Message,
  type MessageTask,
  type TaskDraft,
  type TaskViewer,
} from "@comamessenger/core";
import { spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { useMessenger } from "@/messenger/MessengerProvider";
import { useSignedIn } from "@/session/SessionProvider";
import { useChatMembers } from "@/chatinfo/queries";
import { Avatar } from "@/ui/Avatar";
import { BottomSheet } from "@/ui/BottomSheet";
import { Notice } from "@/ui/Notice";
import { ScreenHeader } from "@/ui/ScreenHeader";
import { Text, maxTextScale } from "@/ui/Text";
import { useNow } from "@/scheduled/clock";
import {
  SectionLabel,
  SmallButton,
  ToggleRow,
  WideButton,
} from "@/requests/parts";
import { TaskCardView } from "./TaskCard";
import {
  ChoiceRow,
  DueField,
  MemberChoice,
  fieldStyles,
  taskPeople,
} from "./fields";
import { taskAssigneeText, useTaskViewer } from "./format";
import { TaskCheck } from "./parts";
import { useTaskActions, type TaskActions } from "./useTasks";

type TaskMessage = Message & { task: MessageTask };

const noticeMs = 2200;

/**
 * The task screen («Изменить» on the card, a row of a list): the card with
 * its buttons and the status history line, then for those who may — the
 * fields of the form (title, description, responsible person, due date,
 * the reminder) and the checklist editor with item people.
 */
export function TaskScreen({
  chatID,
  messageID,
}: {
  chatID: string;
  messageID: string;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { api, user } = useSignedIn();
  const { store } = useMessenger();
  const { members } = useChatMembers(chatID);
  const viewer = useTaskViewer(chatID, members);
  const loaded = useStore(store, (state) =>
    state.messages[chatID]?.find((item) => item.id === messageID),
  );
  const fetched = useQuery({
    queryKey: taskKeys.task(user.id, messageID),
    queryFn: () => api.messageTask(messageID),
  });
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), noticeMs);
    return () => clearTimeout(timer);
  }, [notice]);
  const base = loaded ?? fetched.data;
  const task = newerTask(loaded?.task, fetched.data?.task);
  const message = base && task ? ({ ...base, task } as TaskMessage) : null;
  return (
    <SafeAreaView
      testID="task-screen"
      edges={["bottom"]}
      style={[styles.screen, { backgroundColor: theme.canvas }]}
    >
      <ScreenHeader title={t("taskPanelTask")} backTestID="task-screen-back" />
      {message ? (
        <TaskScreenBody
          message={message}
          members={members}
          viewer={viewer}
          onNotice={setNotice}
        />
      ) : fetched.isError ? (
        <View style={styles.state}>
          <Notice
            title={t("taskLoadFailed")}
            actionLabel={t("retry")}
            onAction={() => void fetched.refetch()}
          />
        </View>
      ) : (
        <ActivityIndicator style={styles.loader} color={theme.muted} />
      )}
      {notice ? (
        <View
          pointerEvents="none"
          accessibilityLiveRegion="polite"
          style={[styles.notice, { backgroundColor: theme.action }]}
        >
          <Text size={14} weight="medium" style={{ color: theme.onAction }}>
            {notice}
          </Text>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

function TaskScreenBody({
  message,
  members,
  viewer,
  onNotice,
}: {
  message: TaskMessage;
  members: ChatMember[];
  viewer: TaskViewer;
  onNotice(text: string): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const actions = useTaskActions(message, onNotice);
  const view = taskCardView(message, viewer, new Date());
  const permissions = view.permissions;
  const open = (path: string) => router.push(path as never);
  return (
    <KeyboardAvoidingView behavior="padding" style={styles.screen}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.content}
      >
        <View
          style={[
            styles.card,
            { backgroundColor: theme.surface, borderColor: theme.border },
          ]}
        >
          <TaskCardView
            message={message}
            members={members}
            viewer={viewer}
            actions={actions}
            hideItems={permissions.manageItems}
            onThread={() =>
              open(`/chat/${message.chat_id}/thread/${message.id}`)
            }
            onSource={(id) => open(`/chat/${message.chat_id}?message=${id}`)}
            onNotice={onNotice}
          />
        </View>
        {permissions.edit || permissions.reassign ? (
          <TaskEditForm
            key={message.task.version}
            message={message}
            members={members}
            actions={actions}
            canEdit={permissions.edit}
            canReassign={permissions.reassign}
            onNotice={onNotice}
          />
        ) : null}
        {permissions.manageItems ? (
          <TaskItemsEditor
            message={message}
            members={members}
            actions={actions}
            checkable={permissions.checkItems}
          />
        ) : null}
        <View style={styles.links}>
          <SmallButton
            testID="task-open-in-chat"
            icon={<ArrowUpRight size={15} color={theme.foreground} />}
            label={t("taskOpenInChat")}
            onPress={() =>
              open(`/chat/${message.chat_id}?message=${message.id}`)
            }
          />
          <SmallButton
            icon={<MessagesSquare size={15} color={theme.foreground} />}
            label={t("taskDiscuss")}
            onPress={() =>
              open(`/chat/${message.chat_id}/thread/${message.id}`)
            }
          />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/** Title, description, due date, the reminder and the responsible person. */
function TaskEditForm({
  message,
  members,
  actions,
  canEdit,
  canReassign,
  onNotice,
}: {
  message: TaskMessage;
  members: ChatMember[];
  actions: TaskActions;
  canEdit: boolean;
  canReassign: boolean;
  onNotice(text: string): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { user } = useSignedIn();
  const now = useNow(30_000);
  const task = message.task;
  const [draft, setDraft] = useState<TaskDraft>(() => taskDraftFromTask(task));
  const [customDue, setCustomDue] = useState(
    () =>
      task.due_at !== null &&
      !taskDuePresets(new Date()).some(
        (preset) => preset.at.getTime() === Date.parse(task.due_at!),
      ),
  );
  const [picking, setPicking] = useState(false);
  const input = taskUpdateInput(task, draft, now);
  const remindAvailable = remindBeforeDueAvailable(draft.dueAt, now);
  const people = taskPeople(members);
  const nameOf = (id: string) =>
    people.find((member) => member.actor_id === id)?.display_name ??
    t("taskSomeone");
  const titleEmpty = !draft.title.trim();
  const update = (patch: Partial<TaskDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));
  const assigneeLabel =
    draft.assignee.kind === "person" && draft.assignee.actorID
      ? draft.assignee.actorID === user.id
        ? t("taskMe")
        : nameOf(draft.assignee.actorID)
      : draft.assignee.kind !== "person"
        ? taskAssigneeText(task, nameOf, t, user.id)
        : t("taskNobody");

  async function save() {
    if (!input || titleEmpty) return;
    const done = await actions.update(input);
    onNotice(done ? t("taskSaved") : t("taskSaveFailed"));
  }

  return (
    <View testID="task-edit" style={styles.section}>
      <SectionLabel>{t("taskEditTitle")}</SectionLabel>
      {canEdit ? (
        <>
          <TextInput
            testID="task-edit-title"
            value={draft.title}
            onChangeText={(title) => update({ title })}
            placeholder={t("taskTitleLabel")}
            placeholderTextColor={theme.muted}
            accessibilityLabel={t("taskTitleLabel")}
            selectionColor={theme.primary}
            maxFontSizeMultiplier={maxTextScale}
            style={[
              fieldStyles.input,
              fieldStyles.title,
              {
                color: theme.foreground,
                backgroundColor: theme.surface,
                borderColor: titleEmpty ? theme.danger : theme.borderStrong,
              },
            ]}
          />
          <TextInput
            testID="task-edit-description"
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
                borderColor: theme.borderStrong,
              },
            ]}
          />
        </>
      ) : null}
      {canReassign ? (
        <>
          <SectionLabel>{t("taskAssigneeLabel")}</SectionLabel>
          <ChoiceRow
            testID="task-edit-assignee"
            label={t("taskAssigneeLabel")}
            value={assigneeLabel}
            onPress={() => setPicking(true)}
          />
        </>
      ) : null}
      {canEdit ? (
        <>
          <SectionLabel>{t("taskDueLabel")}</SectionLabel>
          <DueField
            testID="task-edit-due"
            value={draft.dueAt}
            custom={customDue}
            now={now}
            onChange={(dueAt, custom) => {
              setCustomDue(custom);
              update({ dueAt });
            }}
          />
          <ToggleRow
            testID="task-edit-remind"
            label={t("taskRemind")}
            hint={
              remindAvailable ? t("taskRemindShort") : t("taskRemindNeedsDue")
            }
            value={draft.remindBeforeDue && remindAvailable}
            disabled={!remindAvailable}
            onChange={(remindBeforeDue) => update({ remindBeforeDue })}
          />
        </>
      ) : null}
      <WideButton
        testID="task-edit-save"
        label={t("save")}
        pending={actions.busy === "update"}
        disabled={!input || titleEmpty}
        onPress={() => void save()}
        style={styles.save}
      />
      <BottomSheet
        visible={picking}
        title={t("taskAssigneeLabel")}
        onClose={() => setPicking(false)}
        testID="task-edit-assignee-sheet"
      >
        <MemberChoice
          testID="task-edit-assignee-choice"
          members={members}
          value={
            draft.assignee.kind === "person" ? draft.assignee.actorID : null
          }
          onPick={(actorID) => {
            if (actorID) update({ assignee: { kind: "person", actorID } });
            setPicking(false);
          }}
        />
      </BottomSheet>
    </View>
  );
}

/** The checklist with its people: tick, rename, assign, delete, add. */
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
  const theme = useTheme();
  const task = message.task;
  const people = taskPeople(members);
  const memberOf = (id: string) =>
    people.find((member) => member.actor_id === id);
  const nameOf = (id: string) => memberOf(id)?.display_name ?? t("taskSomeone");
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [newText, setNewText] = useState("");
  const [newWho, setNewWho] = useState<string | null>(null);
  // Whose item is being assigned: an item id, "new" for the new line.
  const [assigning, setAssigning] = useState<string | null>(null);
  const progress = useMemo(
    () => ({ done: task.items_done, total: task.items.length }),
    [task.items.length, task.items_done],
  );

  function commit(itemID: string, original: string) {
    const text = texts[itemID];
    if (text === undefined) return;
    setTexts(({ [itemID]: _, ...rest }) => rest);
    if (text.trim() && text.trim() !== original)
      void actions.changeItem(itemID, { text });
  }

  async function add() {
    if (!newText.trim()) return;
    const done = await actions.addItem(newText, newWho);
    if (done) {
      setNewText("");
      setNewWho(null);
    }
  }

  const assignee = (id: string | null, onPress: () => void, testID: string) => (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={
        id ? t("taskItemAssignee", { name: nameOf(id) }) : t("taskItemAssign")
      }
      hitSlop={4}
      onPress={onPress}
      style={fieldStyles.itemWho}
    >
      {id ? (
        <Avatar
          name={nameOf(id)}
          seed={id}
          size={26}
          actorID={id}
          avatarVersion={memberOf(id)?.avatar_version}
        />
      ) : (
        <UserRound size={18} color={theme.muted} />
      )}
    </Pressable>
  );

  const assigningItem =
    assigning && assigning !== "new"
      ? task.items.find((item) => item.id === assigning)
      : undefined;

  return (
    <View testID="task-items" style={styles.section}>
      <SectionLabel>
        {progress.total
          ? t("taskChecklistProgress", progress)
          : t("taskChecklist")}
      </SectionLabel>
      {task.items.map((item, index) => {
        const done = Boolean(item.done_at);
        return (
          <View key={item.id} style={fieldStyles.item}>
            <TaskCheck
              testID={`task-edit-item-${index}`}
              checked={done}
              label={item.text}
              disabled={!checkable.includes(item.id) || actions.busy === "item"}
              onPress={() => void actions.checkItem(item.id, !done)}
            />
            <TextInput
              value={texts[item.id] ?? item.text}
              onChangeText={(text) =>
                setTexts((current) => ({ ...current, [item.id]: text }))
              }
              onBlur={() => commit(item.id, item.text)}
              onSubmitEditing={() => commit(item.id, item.text)}
              accessibilityLabel={t("taskItemText")}
              selectionColor={theme.primary}
              maxLength={taskLimits.itemMaxLength}
              maxFontSizeMultiplier={maxTextScale}
              style={[
                fieldStyles.itemInput,
                {
                  color: done ? theme.muted : theme.foreground,
                  backgroundColor: theme.surface,
                  borderColor: theme.borderStrong,
                  textDecorationLine: done ? "line-through" : "none",
                },
              ]}
            />
            {assignee(
              item.assignee_id,
              () => setAssigning(item.id),
              `task-edit-item-who-${index}`,
            )}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("taskItemDelete", { text: item.text })}
              hitSlop={6}
              onPress={() => void actions.deleteItem(item.id)}
            >
              <Trash2 size={17} color={theme.muted} />
            </Pressable>
          </View>
        );
      })}
      {task.items.length < taskLimits.maxItems ? (
        <View style={fieldStyles.item}>
          <Plus size={18} color={theme.primary} style={styles.plus} />
          <TextInput
            testID="task-edit-item-new"
            value={newText}
            onChangeText={setNewText}
            onSubmitEditing={() => void add()}
            placeholder={t("taskItemNew")}
            placeholderTextColor={theme.muted}
            accessibilityLabel={t("taskItemNew")}
            selectionColor={theme.primary}
            maxLength={taskLimits.itemMaxLength}
            maxFontSizeMultiplier={maxTextScale}
            returnKeyType="done"
            style={[
              fieldStyles.itemInput,
              {
                color: theme.foreground,
                backgroundColor: theme.surface,
                borderColor: theme.borderStrong,
              },
            ]}
          />
          {assignee(
            newWho,
            () => setAssigning("new"),
            "task-edit-item-new-who",
          )}
          <SmallButton
            testID="task-edit-item-add"
            label={t("taskAddItem")}
            disabled={!newText.trim() || actions.busy === "item"}
            onPress={() => void add()}
          />
        </View>
      ) : null}
      <BottomSheet
        visible={assigning !== null}
        title={t("taskItemAssign")}
        onClose={() => setAssigning(null)}
        testID="task-edit-item-sheet"
      >
        <MemberChoice
          testID="task-edit-item-choice"
          members={members}
          value={
            assigning === "new" ? newWho : (assigningItem?.assignee_id ?? null)
          }
          none={t("taskItemNobody")}
          onPick={(actorID) => {
            if (assigning === "new") setNewWho(actorID);
            else if (assigning)
              void actions.changeItem(assigning, { assigneeID: actorID });
            setAssigning(null);
          }}
        />
      </BottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: spacing[4], paddingBottom: spacing[10] },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 18,
    padding: 12,
  },
  section: { marginTop: spacing[2] },
  gap: { marginTop: 8 },
  save: { marginTop: 14 },
  plus: { marginHorizontal: 1 },
  links: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: spacing[5],
  },
  loader: { marginTop: 40 },
  state: { padding: spacing[5] },
  notice: {
    position: "absolute",
    alignSelf: "center",
    bottom: spacing[6],
    borderRadius: 18,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
    maxWidth: "90%",
  },
});
