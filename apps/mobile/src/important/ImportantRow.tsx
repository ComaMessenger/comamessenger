import { memo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { FileText, Star } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { formatListTime, messagePlainText } from "@comamessenger/core";
import { useTheme } from "@/lib/theme";
import { useSignedIn } from "@/session/SessionProvider";
import { ChatAvatar } from "@/chats/ChatAvatar";
import { chatTitle } from "@/chats/ChatRow";
import { Text } from "@/ui/Text";
import type { ImportantItem } from "./saved";

/**
 * Card of a saved message: author, chat, date, up to three lines of text and
 * the first attachment (prototype `.imp`).
 */
export const ImportantRow = memo(function ImportantRow({
  item,
  testID,
  onOpen,
  onActions,
}: {
  item: ImportantItem;
  testID?: string;
  onOpen(item: ImportantItem): void;
  onActions(item: ImportantItem): void;
}) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const { user } = useSignedIn();
  const { message, author } = item;
  const own = message.actor_id === user.id;
  const authorName = own ? user.display_name : author.display_name;
  const agent = author.type === "agent";
  const avatarVersion = own ? user.avatar_version : author.avatar_version;
  const chatName = item.localChat
    ? chatTitle(item.localChat, t("directChat"))
    : item.chat.display_name || t("directChat");
  const text = messagePlainText(message.body).trim();
  const files = message.files ?? [];
  const time = formatListTime(
    message.created_at,
    i18n.language,
    t("yesterday"),
  );
  const fileLabel = files.length
    ? `${files[0]!.name}${files.length > 1 ? ` ${t("moreFiles", { count: files.length - 1 })}` : ""}`
    : "";

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={[authorName, chatName, time, text, fileLabel]
        .filter(Boolean)
        .join(", ")}
      accessibilityHint={t("importantActionsHint")}
      accessibilityActions={[
        { name: "longpress", label: t("importantActions") },
      ]}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === "longpress") onActions(item);
      }}
      onPress={() => onOpen(item)}
      onLongPress={() => onActions(item)}
      delayLongPress={350}
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: pressed ? theme.surfaceSelected : theme.surface,
          borderBottomColor: theme.border,
        },
      ]}
    >
      <ChatAvatar
        name={authorName}
        seed={message.actor_id}
        size={36}
        shape="circle"
        agent={agent && !avatarVersion}
        actorID={message.actor_id}
        avatarVersion={avatarVersion}
      />
      <View style={styles.body}>
        <View style={styles.line}>
          <Text
            weight="semibold"
            size={14.5}
            numberOfLines={1}
            style={styles.grow}
          >
            {authorName}
          </Text>
          <Star size={12} color={theme.warning} fill={theme.warning} />
          <Text tone="muted" size={12}>
            {time}
          </Text>
        </View>
        <Text
          weight="medium"
          size={12.5}
          tone="primary"
          numberOfLines={1}
          style={styles.chat}
        >
          {chatName}
        </Text>
        {text ? (
          <Text size={14.5} numberOfLines={3}>
            {text}
          </Text>
        ) : null}
        {fileLabel ? (
          <View
            style={[styles.file, { backgroundColor: theme.surfaceSelected }]}
          >
            <FileText size={15} color={theme.muted} />
            <Text size={13} numberOfLines={1} style={styles.fileName}>
              {fileLabel}
            </Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  // Prototype: `.imp { gap: 10px; padding: 11px 14px; border-bottom: 1px }`.
  card: {
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderBottomWidth: 1,
  },
  body: { flex: 1, minWidth: 0 },
  line: { flexDirection: "row", alignItems: "baseline", gap: 6 },
  grow: { flex: 1 },
  chat: { marginBottom: 3 },
  file: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    maxWidth: "100%",
    marginTop: 6,
    paddingVertical: 5,
    paddingHorizontal: 9,
    borderRadius: 10,
  },
  fileName: { flexShrink: 1 },
});
