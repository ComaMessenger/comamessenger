import { memo } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import {
  AlertCircle,
  BellOff,
  Clock,
  CornerUpLeft,
  MessagesSquare,
  Paperclip,
  Trash2,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { messagePlainText, type ScheduledMessage } from "@comamessenger/core";
import { spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { IconButton } from "@/ui/IconButton";
import { Text } from "@/ui/Text";
import { failureText } from "./useScheduled";

export type ScheduledItemAction = "edit" | "time" | "sendNow" | "delete";

function SmallButton({
  label,
  primary = false,
  disabled,
  onPress,
  testID,
}: {
  label: string;
  primary?: boolean;
  disabled: boolean;
  onPress(): void;
  testID?: string;
}) {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: primary ? theme.primary : theme.surfaceSelected,
          opacity: disabled ? 0.5 : pressed ? 0.8 : 1,
        },
      ]}
    >
      <Text
        size={14}
        weight="semibold"
        numberOfLines={1}
        style={{ color: primary ? theme.onPrimary : theme.foreground }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** One scheduled message: time, chat, text and files, and what can be done with it. */
export const ScheduledItem = memo(function ScheduledItem({
  item,
  time,
  chatName,
  busy,
  onAction,
  onOpenChat,
}: {
  item: ScheduledMessage;
  /** «9:00» in a day section, the full moment for a failed one. */
  time: string;
  /** Shown in the list of every chat; null inside one chat. */
  chatName: string | null;
  busy: boolean;
  onAction(item: ScheduledMessage, action: ScheduledItemAction): void;
  onOpenChat?(item: ScheduledMessage): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const failed = item.status === "failed";
  const text = messagePlainText(typeof item.body === "string" ? item.body : "");
  const files = Array.isArray(item.files) ? item.files : [];
  return (
    <View
      testID={`scheduled-item-${item.id}`}
      style={[
        styles.card,
        {
          backgroundColor: theme.surface,
          borderColor: failed ? theme.dangerBorder : theme.border,
        },
      ]}
    >
      <View style={styles.head}>
        <Clock size={14} color={failed ? theme.danger : theme.primary} />
        <Text
          size={12.5}
          weight="semibold"
          style={{ color: failed ? theme.danger : theme.primary }}
        >
          {time}
        </Text>
        {item.silent ? (
          <View
            style={styles.mark}
            accessible
            accessibilityLabel={t("scheduledSilentMark")}
          >
            <BellOff size={13} color={theme.muted} />
          </View>
        ) : null}
        {chatName !== null ? (
          <Pressable
            accessibilityRole="link"
            disabled={!onOpenChat}
            onPress={() => onOpenChat?.(item)}
            hitSlop={8}
            style={styles.right}
          >
            <Text size={12.5} tone="muted" weight="medium" numberOfLines={1}>
              {chatName}
            </Text>
          </Pressable>
        ) : (
          <Text size={12.5} tone="muted" style={styles.right} numberOfLines={1}>
            {t("scheduledOnlyYou")}
          </Text>
        )}
      </View>
      {item.reply_to_id || item.thread_root_id ? (
        <View style={styles.context}>
          {item.thread_root_id ? (
            <MessagesSquare size={13} color={theme.muted} />
          ) : (
            <CornerUpLeft size={13} color={theme.muted} />
          )}
          <Text size={12.5} tone="muted">
            {item.thread_root_id ? t("scheduledInThread") : t("scheduledReply")}
          </Text>
        </View>
      ) : null}
      {text ? (
        <Text size={14.5} numberOfLines={6} style={styles.body}>
          {text}
        </Text>
      ) : null}
      {files.length ? (
        <View style={styles.context}>
          <Paperclip size={13} color={theme.muted} />
          <Text size={13} tone="muted" numberOfLines={1} style={styles.grow}>
            {`${t("scheduledFiles", { count: files.length })}: ${files
              .map((file) => file?.name ?? "")
              .filter(Boolean)
              .join(", ")}`}
          </Text>
        </View>
      ) : null}
      {failed ? (
        <View
          accessibilityRole="alert"
          style={[
            styles.failure,
            {
              backgroundColor: theme.dangerSoft,
              borderColor: theme.dangerBorder,
            },
          ]}
        >
          <AlertCircle size={15} color={theme.danger} />
          <View style={styles.grow}>
            <Text
              size={13}
              weight="semibold"
              style={{ color: theme.dangerText }}
            >
              {t("scheduledFailedLabel")}
            </Text>
            <Text size={13} style={{ color: theme.dangerText }}>
              {failureText(t, item.failure_reason)}
            </Text>
          </View>
        </View>
      ) : null}
      <View style={styles.actions}>
        {failed ? null : (
          <SmallButton
            testID="scheduled-edit"
            label={t("scheduledEdit")}
            disabled={busy}
            onPress={() => onAction(item, "edit")}
          />
        )}
        <SmallButton
          testID="scheduled-time"
          label={t("scheduledTime")}
          disabled={busy}
          onPress={() => onAction(item, "time")}
        />
        <SmallButton
          testID="scheduled-send-now"
          label={t("scheduledSendNow")}
          primary
          disabled={busy}
          onPress={() => onAction(item, "sendNow")}
        />
        <View style={styles.grow} />
        {busy ? (
          <ActivityIndicator color={theme.muted} />
        ) : (
          <IconButton
            testID="scheduled-delete"
            variant="danger"
            size={34}
            label={t("scheduledDelete")}
            onPress={() => onAction(item, "delete")}
            icon={(color) => <Trash2 size={18} color={color} />}
          />
        )}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  // Prototype `.sitem`: radius 16, padding 11px 12px, margin 0 12px 10px.
  card: {
    borderWidth: 1,
    borderRadius: 16,
    paddingVertical: 11,
    paddingHorizontal: 12,
    marginHorizontal: 12,
    marginBottom: 10,
    gap: 4,
  },
  head: { flexDirection: "row", alignItems: "center", gap: 5 },
  mark: { marginLeft: 2 },
  right: { marginLeft: "auto", flexShrink: 1, paddingLeft: spacing[2] },
  context: { flexDirection: "row", alignItems: "center", gap: 5 },
  body: { marginBottom: 2 },
  failure: {
    flexDirection: "row",
    gap: spacing[2],
    borderWidth: 1,
    borderRadius: 12,
    padding: spacing[2],
    marginTop: 2,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 5,
  },
  button: {
    height: 34,
    borderRadius: 10,
    paddingHorizontal: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  grow: { flex: 1 },
});
