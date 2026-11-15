import { memo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import {
  BellOff,
  MessageCircleCheck,
  Pin,
  SquareCheck,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  activeAway,
  avatarBadge,
  currentAway,
  chatAvatarSource,
  chatPreview,
  chatRequestBadge,
  chatTaskBadge,
  formatListTime,
  formatRequestDueDay,
  isChatMuted,
  type Chat,
} from "@comamessenger/core";
import { calendarLocale } from "@/requests/locale";
import { useClock } from "@/scheduled/clock";
import { formatTaskBadgeDue } from "@/tasks/format";
import { useTheme } from "@/lib/theme";
import type { Presence } from "@/ui/Avatar";
import { CountBadge } from "@/ui/CountBadge";
import { Text } from "@/ui/Text";
import { ChatAvatar } from "./ChatAvatar";
import { AwayBadge } from "@/ui/AwayBadge";
import { useAwayOverrides } from "@/status/useAway";

export function chatTitle(chat: Chat, fallback: string): string {
  return chat.display_name || chat.name || fallback;
}

export const ChatRow = memo(function ChatRow({
  chat,
  ownID,
  unreadCount,
  mentionCount,
  presence,
  pinned,
  draft,
  requestsWaiting = 0,
  requestsDueAt = null,
  tasksOpen = 0,
  tasksDueAt = null,
  onOpen,
  onActions,
  testID,
}: {
  chat: Chat;
  ownID: string;
  unreadCount: number;
  mentionCount: number;
  presence?: Presence;
  pinned: boolean;
  /** Unsent text of this chat's composer on this phone. */
  draft?: string;
  /** Requests here wait for the reader: «ответить до пт» or «ждут ответа». */
  requestsWaiting?: number;
  /** The earliest due date among them (ChatUnread.requests_next_due_at). */
  requestsDueAt?: string | null;
  /** Open tasks here on the reader (ChatUnread.tasks_mine_open). */
  tasksOpen?: number;
  /** The earliest due date among them: a burning one gives the red mark. */
  tasksDueAt?: string | null;
  onOpen(chatID: string): void;
  onActions(chatID: string): void;
  testID?: string;
}) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const title = chatTitle(chat, t("directChat"));
  const muted = isChatMuted(chat);
  const peer = chat.direct_peer;
  const agent = chat.kind === "direct" && peer?.type === "agent";
  // «Отсутствую» (phase 6.7): the kind on the avatar of a direct chat.
  const overrides = useAwayOverrides();
  const away =
    chat.kind === "direct" && peer && !agent
      ? activeAway(currentAway(peer.actor_id, peer.away, overrides), new Date())
      : null;
  const online =
    chat.kind === "direct" && !agent && presence === "online" && !away;
  const preview = chatPreview(chat, ownID, {
    you: t("previewYou"),
    deleted: t("previewDeleted"),
    attachment: t("previewAttachment"),
    voice: t("voiceMessage"),
  });
  const draftText = draft?.trim().replace(/\s+/g, " ");
  const time = formatListTime(
    chat.last_message_at ?? chat.created_at,
    i18n.language,
    t("yesterday"),
  );
  const mention = mentionCount > 0;
  const clock = useClock();
  // A burning task on the reader wins over the yellow request mark
  // (decision 19); open tasks that do not burn give no mark.
  const now = new Date();
  const taskBadge = chatTaskBadge(
    { tasks_mine_open: tasksOpen, tasks_mine_next_due_at: tasksDueAt },
    now,
  );
  const taskNeed = taskBadge
    ? taskBadge.kind === "overdue"
      ? t("taskBadgeOverdue")
      : t("taskBadgeDue", {
          when: formatTaskBadgeDue(taskBadge.at, now, clock, i18n.language),
        })
    : null;
  const requestBadge = chatRequestBadge({
    requests_waiting: requestsWaiting,
    requests_next_due_at: requestsDueAt,
  });
  const need = requestBadge
    ? requestBadge.kind === "due"
      ? t("requestAnswerByShort", {
          when: formatRequestDueDay(
            requestBadge.at,
            new Date(),
            calendarLocale(i18n.language),
          ),
        })
      : t("requestWaitingShort")
    : null;
  const label = [
    title,
    agent ? t("agent") : "",
    online ? t("online") : "",
    pinned ? t("pinnedChat") : "",
    muted ? t("muted") : "",
    unreadCount > 0 ? t("unreadCount", { count: unreadCount }) : "",
    mention ? t("mentionedYou") : "",
    taskNeed ?? need ?? "",
    draftText
      ? `${t("draftLabel")}: ${draftText}`
      : `${preview.sender}${preview.text}`,
    time,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={t("chatActionsHint")}
      accessibilityActions={[
        { name: "longpress", label: t("chatActionsTitle") },
      ]}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === "longpress") onActions(chat.id);
      }}
      onPress={() => onOpen(chat.id)}
      onLongPress={() => onActions(chat.id)}
      delayLongPress={350}
      style={({ pressed }) => [
        styles.row,
        pressed && { backgroundColor: theme.surfaceSelected },
      ]}
    >
      <AwayBadge badge={avatarBadge(null, away, new Date())} size={48}>
        <ChatAvatar
          name={title}
          seed={chat.avatar_seed || chat.id}
          size={48}
          shape={chat.kind === "direct" ? "circle" : "square"}
          agent={agent && !(peer?.avatar_version ?? 0)}
          online={online}
          {...chatAvatarSource(chat)}
        />
      </AwayBadge>
      <View style={styles.body}>
        <View style={styles.line}>
          <Text
            weight="semibold"
            size={15.5}
            numberOfLines={1}
            style={styles.grow}
          >
            {title}
          </Text>
          {agent && (
            <View style={[styles.tag, { backgroundColor: theme.primarySoft }]}>
              <Text
                allowFontScaling={false}
                weight="semibold"
                size={10.5}
                style={[styles.tagText, { color: theme.primary }]}
              >
                {t("agentTag")}
              </Text>
            </View>
          )}
          <Text size={12} tone="muted">
            {time}
          </Text>
        </View>
        <View style={styles.line}>
          <Text size={14} tone="muted" numberOfLines={1} style={styles.grow}>
            {draftText ? (
              <>
                <Text size={14} tone="danger">
                  {`${t("draftLabel")}: `}
                </Text>
                {draftText}
              </>
            ) : (
              <>
                {preview.sender ? (
                  <Text size={14}>{preview.sender}</Text>
                ) : null}
                {preview.text}
              </>
            )}
          </Text>
          {pinned && <Pin size={14} color={theme.muted} />}
          {muted && <BellOff size={14} color={theme.muted} />}
          {taskNeed ? (
            <View
              testID="chat-row-task"
              style={[styles.need, { backgroundColor: theme.dangerSoft }]}
            >
              <SquareCheck size={13} color={theme.danger} strokeWidth={2.3} />
              <Text
                allowFontScaling={false}
                weight="bold"
                size={11.5}
                numberOfLines={1}
                style={{ color: theme.danger }}
              >
                {taskNeed}
              </Text>
            </View>
          ) : need ? (
            <View
              testID="chat-row-request"
              style={[styles.need, { backgroundColor: theme.warningSoft }]}
            >
              <MessageCircleCheck
                size={13}
                color={theme.warning}
                strokeWidth={2.3}
              />
              <Text
                allowFontScaling={false}
                weight="bold"
                size={11.5}
                numberOfLines={1}
                style={{ color: theme.warning }}
              >
                {need}
              </Text>
            </View>
          ) : null}
          {mention && <CountBadge value="@" />}
          {unreadCount > 0 && (
            <CountBadge
              value={unreadCount}
              tone={muted ? "muted" : "primary"}
            />
          )}
        </View>
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  // Prototype: `.row { gap: 12px; padding: 9px 14px }`.
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 9,
    minHeight: 66,
  },
  body: { flex: 1, gap: 2 },
  line: { flexDirection: "row", alignItems: "center", gap: 6 },
  grow: { flex: 1 },
  tag: { paddingHorizontal: 5, paddingVertical: 1, borderRadius: 5 },
  // Prototype `.need`: the yellow «ответить до пт».
  need: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    borderRadius: 8,
    paddingHorizontal: 7,
    paddingVertical: 2,
    flexShrink: 0,
  },
  tagText: { textTransform: "uppercase", letterSpacing: 0.2, lineHeight: 14 },
});
