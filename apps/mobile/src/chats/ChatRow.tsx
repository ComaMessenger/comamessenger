import { memo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { BellOff } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  chatPreview,
  formatListTime,
  isChatMuted,
  type Chat,
} from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { Avatar, type Presence } from "@/ui/Avatar";
import { Text } from "@/ui/Text";

export function chatTitle(chat: Chat, fallback: string): string {
  return chat.display_name || chat.name || fallback;
}

function countLabel(value: number) {
  return value > 99 ? "99+" : String(value);
}

export const ChatRow = memo(function ChatRow({
  chat,
  ownID,
  unreadCount,
  mentionCount,
  presence,
  onOpen,
  testID,
}: {
  chat: Chat;
  ownID: string;
  unreadCount: number;
  mentionCount: number;
  presence?: Presence;
  onOpen(chatID: string): void;
  testID?: string;
}) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const title = chatTitle(chat, t("directChat"));
  const muted = isChatMuted(chat);
  const preview = chatPreview(chat, ownID, {
    you: t("previewYou"),
    deleted: t("previewDeleted"),
    attachment: t("previewAttachment"),
  });
  const peer = chat.direct_peer;
  const time = formatListTime(
    chat.last_message_at ?? chat.created_at,
    i18n.language,
    t("yesterday"),
  );
  const mention = unreadCount > 0 && mentionCount > 0;
  const label = [
    title,
    unreadCount > 0 ? t("unreadCount", { count: unreadCount }) : "",
    muted ? t("muted") : "",
    `${preview.sender}${preview.text}`,
    time,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => onOpen(chat.id)}
      style={({ pressed }) => [
        styles.row,
        pressed && { backgroundColor: theme.surfaceSelected },
      ]}
    >
      <Avatar
        name={title}
        seed={chat.avatar_seed || chat.id}
        size={52}
        glyph={chat.kind === "channel" ? "#" : undefined}
        agent={peer?.type === "agent"}
        actorID={chat.kind === "direct" ? peer?.actor_id : undefined}
        avatarVersion={
          chat.kind === "direct" ? peer?.avatar_version : undefined
        }
        presence={
          chat.kind === "direct" && peer?.type !== "agent"
            ? presence
            : undefined
        }
      />
      <View style={styles.body}>
        <View style={styles.line}>
          <Text
            weight="semibold"
            size={17}
            numberOfLines={1}
            style={styles.grow}
          >
            {title}
          </Text>
          {muted && <BellOff size={16} color={theme.subtle} />}
          <Text
            size={14}
            tone={mention ? "primary" : "subtle"}
            weight={mention ? "semibold" : "regular"}
          >
            {time}
          </Text>
        </View>
        <View style={styles.line}>
          <Text size={15} tone="muted" numberOfLines={1} style={styles.grow}>
            {preview.sender ? (
              <Text size={15} weight="medium">
                {preview.sender}
              </Text>
            ) : null}
            {preview.text}
          </Text>
          {unreadCount > 0 && (
            <View
              style={[
                styles.badge,
                {
                  backgroundColor: mention
                    ? theme.primary
                    : muted
                      ? theme.borderStrong
                      : theme.surfaceSelected,
                },
              ]}
            >
              <Text
                size={13}
                weight="semibold"
                style={{ color: mention ? theme.onPrimary : theme.foreground }}
              >
                {countLabel(unreadCount)}
              </Text>
            </View>
          )}
        </View>
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
  },
  body: { flex: 1, gap: 2 },
  line: { flexDirection: "row", alignItems: "center", gap: spacing[2] },
  grow: { flex: 1 },
  badge: {
    minWidth: 24,
    minHeight: 24,
    paddingHorizontal: 7,
    borderRadius: radius.full,
    alignItems: "center",
    justifyContent: "center",
  },
});
