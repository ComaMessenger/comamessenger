import { memo, useRef } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";
import * as Haptics from "expo-haptics";
import {
  AlertCircle,
  Clock3,
  CornerUpLeft,
  Forward,
  MessagesSquare,
  RefreshCw,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  messagePlainText,
  type ChatMember,
  type ClientMessage,
  type MessengerAPI,
} from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { Avatar } from "@/ui/Avatar";
import { Text } from "@/ui/Text";
import { Markdown } from "./Markdown";
import { MessageFiles } from "./MessageFiles";
import { useReactions } from "./reactions";

export type MessageRowProps = {
  api: MessengerAPI;
  ownID: string;
  message: ClientMessage;
  author?: ChatMember;
  grouped: boolean;
  quoted?: ClientMessage;
  quotedAuthor?: string;
  showThread: boolean;
  onReply(message: ClientMessage): void;
  onThread(message: ClientMessage): void;
  onActions(message: ClientMessage): void;
  onRetry(): void;
};

export const MessageRow = memo(function MessageRow({
  api,
  ownID,
  message,
  author,
  grouped,
  quoted,
  quotedAuthor,
  showThread,
  onReply,
  onThread,
  onActions,
  onRetry,
}: MessageRowProps) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const swipeable = useRef<SwipeableMethods>(null);
  const reactions = useReactions(api, message, ownID);
  const own = message.actor_id === ownID;
  const name =
    author?.display_name ?? (own ? t("previewYou") : t("participant"));
  const agent = author?.type === "agent";
  const deleted = Boolean(message.deleted_at);
  const time = new Intl.DateTimeFormat(i18n.language, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(message.created_at));
  const actionable = !deleted && message.delivery !== "sending";
  // Nested buttons (thread link, reactions) pass a long press on to the row
  // menu; without it the release would count as a tap on them.
  const openActions = () => {
    if (!actionable) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onActions(message);
  };

  return (
    <ReanimatedSwipeable
      ref={swipeable}
      enabled={actionable}
      friction={2}
      rightThreshold={56}
      overshootRight={false}
      renderRightActions={() => (
        <View style={styles.swipeAction}>
          <CornerUpLeft size={22} color={theme.primary} />
        </View>
      )}
      onSwipeableWillOpen={() => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onReply(message);
        swipeable.current?.close();
      }}
    >
      <Pressable
        accessibilityHint={t("messageActions")}
        delayLongPress={350}
        onLongPress={openActions}
        style={({ pressed }) => [
          styles.row,
          grouped && styles.rowGrouped,
          pressed && { backgroundColor: theme.surfaceSelected },
        ]}
      >
        <View style={styles.gutter}>
          {!grouped && (
            <Avatar
              name={name}
              seed={message.actor_id}
              size={34}
              agent={agent}
              actorID={message.actor_id}
              avatarVersion={author?.avatar_version}
            />
          )}
        </View>
        <View style={styles.content}>
          {!grouped && (
            <View style={styles.meta}>
              <Text
                weight="semibold"
                size={15}
                numberOfLines={1}
                style={styles.shrink}
              >
                {name}
              </Text>
              {agent && (
                <View
                  style={[styles.tag, { backgroundColor: theme.primarySoft }]}
                >
                  <Text
                    weight="bold"
                    size={10}
                    tone="primary"
                    style={styles.tagText}
                  >
                    {t("agentTag")}
                  </Text>
                </View>
              )}
              <Text tone="subtle" size={12}>
                {time}
              </Text>
              {message.edited_at && !deleted && (
                <Text tone="subtle" size={12}>
                  · {t("edited")}
                </Text>
              )}
            </View>
          )}
          {message.forwarded_from && !deleted && (
            <View style={styles.inline}>
              <Forward size={14} color={theme.muted} />
              <Text tone="muted" size={13}>
                {t("forwardedFrom", {
                  name: message.forwarded_from.author_name,
                })}
              </Text>
            </View>
          )}
          {message.reply_to_id && !deleted && (
            <View
              style={[
                styles.quote,
                {
                  borderLeftColor: theme.primary,
                  backgroundColor: theme.canvas,
                },
              ]}
            >
              <Text
                weight="semibold"
                size={13}
                tone="primary"
                numberOfLines={1}
              >
                {quotedAuthor ?? t("reply")}
              </Text>
              <Text tone="muted" size={13} numberOfLines={2}>
                {quoted ? messagePlainText(quoted.body) : "…"}
              </Text>
            </View>
          )}
          {deleted ? (
            <Text tone="muted" size={15} style={styles.italic}>
              {t("messageDeleted")}
            </Text>
          ) : (
            <Markdown source={message.body} />
          )}
          {!deleted && message.files.length > 0 && (
            <MessageFiles api={api} files={message.files} />
          )}
          {reactions.groups.length > 0 && !deleted && (
            <View style={styles.reactions}>
              {reactions.groups.map((group) => (
                <Pressable
                  key={group.emoji}
                  accessibilityRole="button"
                  accessibilityState={{ selected: group.own }}
                  accessibilityLabel={t("reactionCount", group)}
                  onPress={() =>
                    void reactions.toggle(group.emoji).catch(() => undefined)
                  }
                  onLongPress={openActions}
                  style={[
                    styles.chip,
                    {
                      backgroundColor: group.own
                        ? theme.primarySoft
                        : theme.surface,
                      borderColor: group.own ? theme.primary : theme.border,
                    },
                  ]}
                >
                  <Text size={14}>{group.emoji}</Text>
                  <Text weight="semibold" size={13}>
                    {group.count}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}
          {showThread && message.thread_reply_count > 0 && !deleted && (
            <Pressable
              accessibilityRole="button"
              onPress={() => onThread(message)}
              onLongPress={openActions}
              style={styles.inline}
              hitSlop={8}
            >
              <MessagesSquare size={18} color={theme.primary} />
              <Text weight="semibold" size={14} tone="primary">
                {t("threadReplies", { count: message.thread_reply_count })}
              </Text>
            </Pressable>
          )}
          {message.delivery && message.delivery !== "sent" && (
            <View style={styles.inline}>
              {message.delivery === "sending" ? (
                <>
                  <Clock3 size={14} color={theme.subtle} />
                  <Text tone="subtle" size={13}>
                    {t("deliverySending")}
                  </Text>
                </>
              ) : message.delivery === "retrying" ? (
                <>
                  <RefreshCw size={14} color={theme.subtle} />
                  <Text tone="subtle" size={13}>
                    {t("retrying")}
                  </Text>
                </>
              ) : (
                <>
                  <AlertCircle size={14} color={theme.danger} />
                  <Text tone="danger" size={13}>
                    {t("notSent")}
                  </Text>
                  <Text
                    accessibilityRole="button"
                    tone="primary"
                    weight="semibold"
                    size={13}
                    onPress={onRetry}
                  >
                    {t("retry")}
                  </Text>
                </>
              )}
            </View>
          )}
        </View>
      </Pressable>
    </ReanimatedSwipeable>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
    paddingBottom: spacing[1],
  },
  rowGrouped: { paddingTop: 0 },
  gutter: { width: 34 },
  content: { flex: 1, gap: spacing[1] },
  meta: { flexDirection: "row", alignItems: "center", gap: spacing[2] },
  shrink: { flexShrink: 1 },
  tag: {
    height: 18,
    paddingHorizontal: 7,
    borderRadius: 6,
    justifyContent: "center",
  },
  tagText: { textTransform: "uppercase", letterSpacing: 0.4 },
  inline: { flexDirection: "row", alignItems: "center", gap: spacing[1] },
  quote: {
    borderLeftWidth: 2,
    borderTopRightRadius: radius.md,
    borderBottomRightRadius: radius.md,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[1],
  },
  italic: { fontStyle: "italic" },
  reactions: { flexDirection: "row", flexWrap: "wrap", gap: spacing[1] },
  chip: {
    height: 28,
    paddingHorizontal: 10,
    borderRadius: radius.full,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  swipeAction: { width: 64, alignItems: "center", justifyContent: "center" },
});
