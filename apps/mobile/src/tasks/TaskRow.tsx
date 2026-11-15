import { memo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
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
import { useTheme } from "@/lib/theme";
import { Avatar } from "@/ui/Avatar";
import { Text } from "@/ui/Text";
import { useNow } from "@/scheduled/clock";
import { calendarLocale } from "@/requests/locale";
import { TaskCheck } from "./parts";
import { useTaskActions } from "./useTasks";

export type TaskRowMessage = Pick<
  Message,
  "id" | "chat_id" | "actor_id" | "created_seq"
> & { task: MessageTask };

/**
 * One task in a list (prototype `.trow`): the round «Готово» for those who
 * may close it, the title, «на вас» or the name, the due date (red when it
 * burns), «2/3», the chat. A tap opens the task.
 */
export const TaskRow = memo(function TaskRow({
  message,
  viewer,
  members,
  mine,
  chatName,
  people,
  testID,
  onOpen,
  onNotice,
}: {
  message: TaskRowMessage;
  viewer: TaskViewer;
  /** Members of the chat, for names; lists across chats pass `people`. */
  members?: readonly Pick<
    ChatMember,
    "actor_id" | "display_name" | "avatar_version"
  >[];
  /** A red line on the left: «На вас» of the list under the slot. */
  mine?: boolean;
  /** «Важные»: the chat the task lives in. */
  chatName?: string;
  /** Extra names when the members are unknown (the author of an inbox item). */
  people?: readonly Pick<
    ChatMember,
    "actor_id" | "display_name" | "avatar_version"
  >[];
  testID?: string;
  onOpen(): void;
  onNotice?(text: string): void;
}) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const now = useNow(60_000);
  const actions = useTaskActions(message, onNotice);
  const task = message.task;
  const permissions = taskPermissions(task, message.actor_id, viewer);
  const done = task.status === "done";
  const canToggle = isTaskActive(task)
    ? permissions.complete
    : done && permissions.reopen;
  const hot = isTaskHot(task, now);
  const everyone = [...(members ?? []), ...(people ?? [])];
  const person = (id: string) =>
    everyone.find((member) => member.actor_id === id);
  const assigneeID = task.assignee.actor_id;
  // «на вас» when the reader answers for it; an item of theirs keeps the
  // name of the responsible person, as in the prototype.
  const who = assigneeID
    ? assigneeID === viewer.actorID
      ? t("taskOnYou")
      : // First names in lists, as in the prototype («Олег · сегодня, 17:00»).
        (person(assigneeID)?.display_name.split(/\s+/)[0] ?? t("taskSomeone"))
    : task.assignee.label;
  const parts = [
    task.due_at
      ? {
          text: formatTaskDue(
            new Date(task.due_at),
            now,
            calendarLocale(i18n.language),
          ),
          hot: hot && isTaskActive(task),
        }
      : null,
    task.items.length
      ? { text: `${task.items_done}/${task.items.length}`, hot: false }
      : null,
    chatName ? { text: chatName, hot: false } : null,
  ].filter((part): part is { text: string; hot: boolean } => part !== null);
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={[task.title, who, ...parts.map((part) => part.text)]
        .filter(Boolean)
        .join(", ")}
      onPress={onOpen}
      style={({ pressed }) => [
        styles.row,
        {
          backgroundColor: pressed ? theme.surfaceSelected : theme.surface,
          borderBottomColor: theme.border,
        },
        mine && { borderLeftColor: theme.danger, borderLeftWidth: 3 },
      ]}
    >
      <TaskCheck
        testID={testID ? `${testID}-check` : undefined}
        round
        size={22}
        checked={done}
        label={t(done ? "taskRowReopen" : "taskRowComplete", {
          title: task.title,
        })}
        disabled={!canToggle || actions.busy === "status"}
        onPress={
          canToggle
            ? () => void actions.setStatus(done ? "open" : "done")
            : undefined
        }
      />
      <View style={styles.body}>
        <Text
          size={15}
          weight="medium"
          numberOfLines={2}
          style={
            done || task.status === "canceled"
              ? { color: theme.muted, textDecorationLine: "line-through" }
              : undefined
          }
        >
          {task.title}
        </Text>
        <View style={styles.small}>
          {assigneeID ? (
            <Avatar
              name={person(assigneeID)?.display_name ?? who}
              seed={assigneeID}
              size={18}
              actorID={assigneeID}
              avatarVersion={person(assigneeID)?.avatar_version}
            />
          ) : null}
          <Text
            tone="muted"
            size={12.5}
            numberOfLines={2}
            style={styles.shrink}
          >
            {who}
            {parts.map((part, index) => (
              <Text
                key={index}
                size={12.5}
                weight={part.hot ? "semibold" : "regular"}
                style={{ color: part.hot ? theme.danger : theme.muted }}
              >
                <Text size={12.5} style={{ color: theme.muted }}>
                  {" · "}
                </Text>
                {part.text}
              </Text>
            ))}
          </Text>
          {task.status === "in_progress" ? (
            <View style={[styles.pill, { backgroundColor: theme.primarySoft }]}>
              <Text weight="bold" size={10.5} style={{ color: theme.primary }}>
                {t("taskStatusInProgress").toLocaleLowerCase()}
              </Text>
            </View>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  // Prototype `.trow`: padding 10px 14px, gap 11px, bottom border.
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 11,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  body: { flex: 1, minWidth: 0, gap: 2 },
  small: { flexDirection: "row", alignItems: "center", gap: 6 },
  shrink: { flexShrink: 1 },
  pill: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: 8 },
});
