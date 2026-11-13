import { memo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { AlertCircle, BellOff, Clock, Paperclip } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { messagePlainText, type ScheduledMessage } from "@comamessenger/core";
import { useTheme } from "@/lib/theme";
import { Text } from "@/ui/Text";
import { useNow, useWhen } from "./clock";
import { ScheduledBoundary } from "./ScheduledBoundary";

/**
 * The author's own scheduled messages at the end of the feed, as dashed
 * bubbles with their send time (prototype `.sched`). Nobody else sees them.
 * A chat shows those outside threads, a thread its own; waiting ones by send
 * time, then the unsent ones. A press opens the record in the list.
 */
export function ScheduledBubbles({
  items,
  chatID,
  threadRootID,
  onOpen,
}: {
  items: readonly ScheduledMessage[];
  chatID: string;
  threadRootID: string | null;
  onOpen(item: ScheduledMessage): void;
}) {
  const shown = items
    .filter(
      (item) =>
        item.chat_id === chatID &&
        (item.thread_root_id ?? null) === threadRootID &&
        (item.status === "pending" || item.status === "failed"),
    )
    .sort(
      (left, right) =>
        Number(left.status === "failed") - Number(right.status === "failed") ||
        Date.parse(left.send_at) - Date.parse(right.send_at),
    );
  if (!shown.length) return null;
  return (
    <ScheduledBoundary quiet>
      <View style={styles.list}>
        {shown.map((item) => (
          <ScheduledBubble key={item.id} item={item} onOpen={onOpen} />
        ))}
      </View>
    </ScheduledBoundary>
  );
}

const ScheduledBubble = memo(function ScheduledBubble({
  item,
  onOpen,
}: {
  item: ScheduledMessage;
  onOpen(item: ScheduledMessage): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const when = useWhen();
  const now = useNow(60_000);
  const failed = item.status === "failed";
  const text = messagePlainText(typeof item.body === "string" ? item.body : "");
  const files = Array.isArray(item.files) ? item.files : [];
  const state = failed
    ? t("scheduledFeedFailed")
    : t("scheduledFeedWhen", { when: when(new Date(item.send_at), now, "at") });
  const tint = failed ? theme.danger : theme.primary;
  return (
    <Pressable
      testID="scheduled-bubble"
      accessibilityRole="button"
      accessibilityLabel={`${text || files.map((file) => file?.name).join(", ")}. ${t("scheduledFeedLabel", { state })}`}
      onPress={() => onOpen(item)}
      style={({ pressed }) => [
        styles.bubble,
        {
          borderColor: failed ? theme.dangerBorder : theme.borderStrong,
          backgroundColor: pressed ? theme.surfaceSelected : "transparent",
        },
      ]}
    >
      {text ? (
        <Text size={16} numberOfLines={8}>
          {text}
        </Text>
      ) : null}
      {files.length ? (
        <View style={styles.line}>
          <Paperclip size={13} color={theme.muted} />
          <Text size={13} tone="muted" numberOfLines={1} style={styles.shrink}>
            {files.map((file) => file?.name ?? "").join(", ")}
          </Text>
        </View>
      ) : null}
      <View style={styles.line}>
        {failed ? (
          <AlertCircle size={13} color={tint} />
        ) : (
          <Clock size={13} color={tint} />
        )}
        <Text
          size={11.5}
          weight="semibold"
          style={[styles.shrink, { color: tint }]}
        >
          {state}
        </Text>
        {item.silent ? <BellOff size={12} color={theme.muted} /> : null}
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  list: { gap: 5, paddingTop: 5 },
  // Prototype `.sched .bub`: 1.5px dashed border-strong, radius 18 18 6 18,
  // no fill; `.sched`: right, max 86 %.
  bubble: {
    alignSelf: "flex-end",
    maxWidth: "86%",
    // The feed rows' side padding (MessageRow `row`).
    marginRight: 10,
    borderWidth: 1.5,
    borderStyle: "dashed",
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderBottomLeftRadius: 18,
    borderBottomRightRadius: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    gap: 3,
  },
  line: { flexDirection: "row", alignItems: "center", gap: 4 },
  shrink: { flexShrink: 1 },
});
