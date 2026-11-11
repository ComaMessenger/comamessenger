import { memo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { BellOff, Pin } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  chatAvatarSource,
  chatPreview,
  formatListTime,
  isChatMuted,
  type Chat,
} from "@comamessenger/core";
import { useTheme } from "@/lib/theme";
import type { Presence } from "@/ui/Avatar";
import { CountBadge } from "@/ui/CountBadge";
import { Text } from "@/ui/Text";
import { ChatAvatar } from "./ChatAvatar";

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
  const online = chat.kind === "direct" && !agent && presence === "online";
  const preview = chatPreview(chat, ownID, {
    you: t("previewYou"),
    deleted: t("previewDeleted"),
    attachment: t("previewAttachment"),
  });
  const draftText = draft?.trim().replace(/\s+/g, " ");
  const time = formatListTime(
    chat.last_message_at ?? chat.created_at,
    i18n.language,
    t("yesterday"),
  );
  const mention = mentionCount > 0;
  const label = [
    title,
    agent ? t("agent") : "",
    online ? t("online") : "",
    pinned ? t("pinnedChat") : "",
    muted ? t("muted") : "",
    unreadCount > 0 ? t("unreadCount", { count: unreadCount }) : "",
    mention ? t("mentionedYou") : "",
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
      <ChatAvatar
        name={title}
        seed={chat.avatar_seed || chat.id}
        size={48}
        shape={chat.kind === "direct" ? "circle" : "square"}
        agent={agent && !(peer?.avatar_version ?? 0)}
        online={online}
        {...chatAvatarSource(chat)}
      />
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
  tagText: { textTransform: "uppercase", letterSpacing: 0.2, lineHeight: 14 },
});
