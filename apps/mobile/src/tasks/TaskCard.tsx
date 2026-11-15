import { useMemo, useState, type ReactNode } from "react";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import {
  Bell,
  Check,
  Clock3,
  Flame,
  MessagesSquare,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  SquareCheck,
  Users,
  X,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  formatTaskDue,
  isTaskActive,
  taskCardView,
  type ChatMember,
  type Message,
  type MessageTask,
  type TaskViewer,
} from "@comamessenger/core";
import { useTheme } from "@/lib/theme";
import { useSignedIn } from "@/session/SessionProvider";
import { Avatar } from "@/ui/Avatar";
import { MenuSheet, type MenuSheetItem } from "@/ui/MenuSheet";
import { Text } from "@/ui/Text";
import { Markdown } from "@/conversation/Markdown";
import { useClock, useNow } from "@/scheduled/clock";
import { formatTime } from "@/scheduled/format";
import { calendarLocale } from "@/requests/locale";
import { SmallButton } from "@/requests/parts";
import { taskAssigneeText, useTaskViewer } from "./format";
import { TaskCheck, TaskPill, useTaskJump } from "./parts";
import { useTaskActions, type TaskActions } from "./useTasks";

export type TaskCardMessage = Pick<
  Message,
  "id" | "chat_id" | "actor_id" | "created_at"
> & { task: MessageTask };

/**
 * A «Задача» in the feed, as in the prototype's «Компоненты»: the head
 * «Задача · 1 из 3» with the status or a red «Просрочена», the title
 * (struck out when done), the description, who answers and when, the
 * checklist with its people, «из сообщения …», and the buttons this
 * reader may press. «⋯» holds «Изменить», «Отменить задачу» and «Обсудить
 * в треде». Changes show at once and roll back with a notice.
 */
export function TaskCard({
  message,
  members,
  preview = false,
  onNotice,
}: {
  message: TaskCardMessage;
  members: readonly ChatMember[];
  /** The still copy in the long-press menu. */
  preview?: boolean;
  onNotice?(text: string): void;
}) {
  const viewer = useTaskViewer(message.chat_id, members);
  const actions = useTaskActions(message, onNotice);
  const jump = useTaskJump();
  return (
    <TaskCardView
      message={message}
      members={members}
      viewer={viewer}
      actions={actions}
      interactive={!preview}
      onOpen={() => router.push(`/chat/${message.chat_id}/task/${message.id}`)}
      onThread={() =>
        router.push(`/chat/${message.chat_id}/thread/${message.id}`)
      }
      onSource={(id) =>
        jump ? jump(id) : router.push(`/chat/${message.chat_id}?message=${id}`)
      }
      onNotice={onNotice}
    />
  );
}

/** The card itself, for the feed and the task screen. */
export function TaskCardView({
  message,
  members,
  viewer,
  actions,
  interactive = true,
  hideItems = false,
  onOpen,
  onThread,
  onSource,
  onNotice,
}: {
  message: TaskCardMessage;
  members: readonly ChatMember[];
  viewer: TaskViewer;
  actions: TaskActions;
  interactive?: boolean;
  /** The task screen edits the checklist below the card. */
  hideItems?: boolean;
  /** «Изменить» / «Подробнее»: the task screen. */
  onOpen?(): void;
  onThread?(): void;
  onSource?(messageID: string): void;
  onNotice?(text: string): void;
}) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const clock = useClock();
  const now = useNow(60_000);
  const { user } = useSignedIn();
  const locale = calendarLocale(i18n.language);
  const [menuOpen, setMenuOpen] = useState(false);
  const memberIDs = useMemo(
    () => new Set(members.map((member) => member.actor_id)),
    [members],
  );
  const task = message.task;
  const view = taskCardView(message, viewer, now, memberIDs);
  const permissions = view.permissions;
  const memberOf = (actorID: string) =>
    members.find((member) => member.actor_id === actorID);
  const nameOf = (actorID: string) =>
    memberOf(actorID)?.display_name ?? t("taskSomeone");
  const self = user.id;
  const busy = actions.busy;
  const closed = task.status === "done" || task.status === "canceled";
  const canEditSomething =
    permissions.edit || permissions.manageItems || permissions.reassign;

  const buttons: ReactNode[] = [];
  if (interactive) {
    if (permissions.take)
      buttons.push(
        <SmallButton
          key="take"
          testID="task-take"
          variant="primary"
          label={t("taskTake")}
          disabled={busy === "take"}
          onPress={() => void actions.take()}
        />,
      );
    if (task.status === "open" && permissions.start)
      buttons.push(
        <SmallButton
          key="start"
          testID="task-start"
          label={t("taskStart")}
          disabled={busy === "status"}
          onPress={() => void actions.setStatus("in_progress")}
        />,
      );
    if (isTaskActive(task) && permissions.complete)
      buttons.push(
        <SmallButton
          key="done"
          testID="task-complete"
          variant="primary"
          icon={<Check size={15} strokeWidth={2.4} color={theme.onPrimary} />}
          label={t("taskComplete")}
          disabled={busy === "status"}
          onPress={() => void actions.setStatus("done")}
        />,
      );
    if (task.status === "done" && permissions.reopen)
      buttons.push(
        <SmallButton
          key="reopen"
          testID="task-reopen"
          icon={<RotateCcw size={15} color={theme.foreground} />}
          label={t("taskReopen")}
          disabled={busy === "status"}
          onPress={() => void actions.setStatus("open")}
        />,
      );
    if (task.status === "canceled" && permissions.restore)
      buttons.push(
        <SmallButton
          key="restore"
          testID="task-restore"
          icon={<RotateCcw size={15} color={theme.foreground} />}
          label={t("taskRestore")}
          disabled={busy === "status"}
          onPress={() => void actions.setStatus("open")}
        />,
      );
    if (view.nudge.kind === "ready")
      buttons.push(
        <SmallButton
          key="nudge"
          testID="task-nudge"
          icon={<Bell size={15} color={theme.foreground} />}
          label={view.queue ? t("taskNudgeQueue") : t("taskNudge")}
          disabled={busy === "nudge"}
          onPress={() =>
            void actions.nudge().then((done) => {
              if (done) onNotice?.(t("taskNudged"));
            })
          }
        />,
      );
  }

  const statusLine =
    closed && task.status_changed_at
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
            time: formatTime(new Date(task.status_changed_at), clock),
          },
        )
      : null;

  const menu: MenuSheetItem[] = [];
  if (onOpen)
    menu.push({
      key: "open",
      testID: "task-menu-edit",
      label: canEditSomething ? t("taskEdit") : t("taskDetails"),
      icon: <Pencil size={20} color={theme.muted} />,
      onPress: onOpen,
    });
  if (task.status === "in_progress" && permissions.stop)
    menu.push({
      key: "stop",
      testID: "task-menu-stop",
      label: t("taskStop"),
      icon: <RotateCcw size={20} color={theme.muted} />,
      onPress: () => void actions.setStatus("open"),
    });
  if (onThread)
    menu.push({
      key: "thread",
      testID: "task-menu-thread",
      label: t("taskDiscuss"),
      icon: <MessagesSquare size={20} color={theme.muted} />,
      onPress: onThread,
    });
  if (permissions.cancel)
    menu.push({
      key: "cancel",
      testID: "task-menu-cancel",
      label: t("taskCancel"),
      icon: <X size={20} color={theme.danger} />,
      danger: true,
      onPress: () =>
        // iOS cannot show an alert while the sheet is still closing.
        setTimeout(
          () =>
            Alert.alert(t("taskCancelTitle"), t("taskCancelHint"), [
              { text: t("taskKeep"), style: "cancel" },
              {
                text: t("taskCancel"),
                style: "destructive",
                onPress: () => void actions.setStatus("canceled"),
              },
            ]),
          350,
        ),
    });

  const assigneeID = task.assignee.actor_id;
  const progress = view.progress;
  return (
    <View testID="task-card" style={styles.card}>
      <View style={styles.head}>
        <SquareCheck size={15} color={theme.muted} />
        <Text tone="muted" weight="semibold" size={12} style={styles.grow}>
          {progress.total
            ? t("taskCardLabelProgress", {
                done: progress.done,
                total: progress.total,
              })
            : t("taskCardLabel")}
        </Text>
        <TaskPill view={view} />
        {interactive && menu.length > 0 ? (
          <Pressable
            testID="task-menu"
            accessibilityRole="button"
            accessibilityLabel={t("taskMenu")}
            hitSlop={10}
            onPress={() => setMenuOpen(true)}
            style={styles.more}
          >
            <MoreHorizontal size={18} color={theme.muted} />
          </Pressable>
        ) : null}
      </View>
      <Text
        testID="task-title"
        weight="semibold"
        size={15.5}
        style={[
          styles.title,
          closed && {
            color: theme.muted,
            textDecorationLine: "line-through",
          },
        ]}
      >
        {task.title}
      </Text>
      {task.description ? (
        <View style={styles.description}>
          <Markdown source={task.description} size={13.5} />
        </View>
      ) : null}
      <View style={styles.meta}>
        {assigneeID ? (
          <View style={styles.who}>
            <Avatar
              name={nameOf(assigneeID)}
              seed={assigneeID}
              size={20}
              actorID={assigneeID}
              avatarVersion={memberOf(assigneeID)?.avatar_version}
            />
            <Text tone="muted" size={13} style={styles.shrink}>
              {t("taskResponsible", {
                name: taskAssigneeText(task, nameOf, t, self),
              })}
              {view.assigneeAway ? (
                <Text size={13} style={{ color: theme.warning }}>
                  {` · ${t("taskNotInChat")}`}
                </Text>
              ) : null}
            </Text>
          </View>
        ) : (
          <View style={styles.who}>
            <Users size={14} color={theme.muted} />
            <Text tone="muted" size={13} style={styles.shrink}>
              {`${taskAssigneeText(task, nameOf, t, self)} · ${t(
                "taskQueueHint",
                { count: task.assignee.candidate_ids.length },
              )}`}
            </Text>
          </View>
        )}
        {view.dueAt ? (
          <View style={styles.who}>
            {view.hot ? (
              <Flame size={14} color={theme.danger} />
            ) : (
              <Clock3 size={14} color={theme.muted} />
            )}
            <Text
              testID="task-due"
              size={13}
              style={{ color: view.hot ? theme.danger : theme.muted }}
            >
              {formatTaskDue(view.dueAt, now, locale)}
            </Text>
          </View>
        ) : null}
      </View>
      {task.items.length > 0 && !hideItems ? (
        <View style={styles.items} accessibilityLabel={t("taskChecklist")}>
          {task.items.map((item, index) => {
            const allowed =
              interactive && permissions.checkItems.includes(item.id);
            const done = Boolean(item.done_at);
            return (
              // The whole line ticks the item (prototype `.cli`).
              <Pressable
                key={item.id}
                testID={`task-item-${index}`}
                accessibilityRole="checkbox"
                accessibilityLabel={item.text}
                accessibilityState={{
                  checked: done,
                  disabled: !allowed || busy === "item",
                }}
                disabled={!allowed || busy === "item"}
                onPress={() => void actions.checkItem(item.id, !done)}
                style={styles.item}
              >
                <TaskCheck
                  checked={done}
                  label={item.text}
                  disabled={!allowed}
                />
                <Text
                  size={15}
                  style={[
                    styles.grow,
                    done && {
                      color: theme.muted,
                      textDecorationLine: "line-through",
                    },
                  ]}
                >
                  {item.text}
                </Text>
                {item.assignee_id ? (
                  <View
                    style={styles.itemWho}
                    accessible
                    accessibilityLabel={t("taskItemAssignee", {
                      name: nameOf(item.assignee_id),
                    })}
                  >
                    {!item.assignee_in_chat ? (
                      <Text size={11.5} style={{ color: theme.warning }}>
                        {t("taskNotInChat")}
                      </Text>
                    ) : null}
                    <Avatar
                      name={nameOf(item.assignee_id)}
                      seed={item.assignee_id}
                      size={18}
                      actorID={item.assignee_id}
                      avatarVersion={memberOf(item.assignee_id)?.avatar_version}
                    />
                  </View>
                ) : null}
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {task.source ? (
        <Pressable
          testID="task-source"
          accessibilityRole="link"
          disabled={!interactive || task.source.deleted || !onSource}
          onPress={() => onSource?.(task.source!.message_id)}
          style={[styles.source, { borderLeftColor: theme.borderStrong }]}
        >
          <Text tone="muted" size={12.5} numberOfLines={2}>
            {task.source.deleted
              ? t("taskSourceDeleted")
              : t("taskSource", {
                  name: nameOf(task.source.author_id),
                  excerpt: task.source.excerpt,
                })}
          </Text>
        </Pressable>
      ) : null}
      {view.queueEmpty && (permissions.reassign || permissions.edit) ? (
        <Text size={12.5} style={[styles.note, { color: theme.warning }]}>
          {t("taskQueueEmpty")}
        </Text>
      ) : null}
      {view.assigneeAway && permissions.reassign ? (
        <Text size={12.5} style={[styles.note, { color: theme.warning }]}>
          {t("taskAssigneeAwayHint")}
        </Text>
      ) : null}
      {view.suggestComplete ? (
        <Text size={12.5} style={[styles.note, { color: theme.success }]}>
          {t("taskSuggestComplete")}
        </Text>
      ) : null}
      {statusLine ? (
        <Text
          testID="task-status-line"
          tone="muted"
          size={12.5}
          style={styles.note}
        >
          {statusLine}
        </Text>
      ) : null}
      {buttons.length > 0 || (interactive && view.nudge.kind === "cooldown") ? (
        <View style={styles.actions}>
          {buttons}
          {view.nudge.kind === "cooldown" ? (
            <Text tone="muted" size={12.5} style={styles.cooldown}>
              {t("taskNudgeCooldown", {
                when: formatTaskDue(view.nudge.until, now, locale),
              })}
            </Text>
          ) : null}
        </View>
      ) : null}
      {menuOpen ? (
        <MenuSheet
          visible
          testID="task-menu-sheet"
          items={menu}
          onClose={() => setMenuOpen(false)}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { minWidth: 0 },
  // Prototype `.tk-h`: 12px, 600, muted; the pill on the right.
  head: { flexDirection: "row", alignItems: "center", gap: 6 },
  grow: { flex: 1, minWidth: 0 },
  shrink: { flexShrink: 1 },
  more: { marginLeft: 2 },
  // `.tk-t`: 15.5px, 600, margin 5px 0 6px.
  title: { marginTop: 5, marginBottom: 6, lineHeight: 20 },
  description: { marginTop: -2, marginBottom: 6, opacity: 0.85 },
  // `.tk-m`: 13px muted, gap 6px 10px, wraps.
  meta: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: 10,
    rowGap: 6,
  },
  who: { flexDirection: "row", alignItems: "center", gap: 5, flexShrink: 1 },
  // `.cli`: 6px 0, gap 10px, 15px.
  items: { marginTop: 6 },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 6,
  },
  itemWho: { flexDirection: "row", alignItems: "center", gap: 4 },
  // `.tk-src`: 12.5px muted, a 2px line on the left.
  source: { borderLeftWidth: 2, paddingLeft: 7, marginTop: 7 },
  note: { marginTop: 7 },
  // `.tk-a`: gap 6px, margin-top 9px, wraps.
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 6,
    marginTop: 9,
  },
  cooldown: { flexShrink: 1 },
});
