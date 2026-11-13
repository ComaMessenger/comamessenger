import { Pressable, StyleSheet, View } from "react-native";
import { ChevronRight, Clock } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { pendingSummary, type ScheduledMessage } from "@comamessenger/core";
import { useTheme } from "@/lib/theme";
import { Text } from "@/ui/Text";
import { useNow, useWhen } from "./clock";
import { ScheduledBoundary } from "./ScheduledBoundary";

/**
 * «Отложено: N · ближайшее завтра в 9:00» under the chat header. Only the
 * author has scheduled messages to see, and the strip is absent at zero.
 */
export function ScheduledStrip({
  chatID,
  items,
  onPress,
}: {
  chatID: string;
  items: readonly ScheduledMessage[];
  onPress(): void;
}) {
  return (
    <ScheduledBoundary quiet>
      <StripContent chatID={chatID} items={items} onPress={onPress} />
    </ScheduledBoundary>
  );
}

/** Waiting and unsent records of the chat: everything the strip counts. */
export function stripSummary(
  items: readonly ScheduledMessage[],
  chatID: string,
) {
  const pending = pendingSummary(items, chatID);
  const failed = items.filter(
    (item) => item.chat_id === chatID && item.status === "failed",
  ).length;
  return {
    count: pending.count + failed,
    failed,
    nearest: pending.next ? new Date(pending.next.send_at) : null,
  };
}

function StripContent({
  chatID,
  items,
  onPress,
}: {
  chatID: string;
  items: readonly ScheduledMessage[];
  onPress(): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const when = useWhen();
  const now = useNow(60_000);
  const summary = stripSummary(items, chatID);
  if (summary.count === 0) return null;
  const details = [
    summary.nearest
      ? t("scheduledStripNearest", { when: when(summary.nearest, now, "at") })
      : null,
    summary.failed
      ? t("scheduledStripFailed", { count: summary.failed })
      : null,
  ].filter(Boolean);
  return (
    <Pressable
      testID="scheduled-strip"
      accessibilityRole="button"
      accessibilityLabel={`${t("scheduledStripLabel", { count: summary.count })}. ${details.join(", ")}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.strip,
        {
          backgroundColor: pressed ? theme.surfaceSelected : theme.surface,
          borderBottomColor: theme.border,
        },
      ]}
    >
      <Clock size={16} color={summary.failed ? theme.danger : theme.primary} />
      <View style={styles.text}>
        <Text size={13} tone="muted" numberOfLines={1}>
          <Text size={13} weight="semibold">
            {t("scheduledStripCount", { count: summary.count })}
          </Text>
          {details.length ? ` · ${details[0]}` : ""}
          {details.length > 1 ? (
            <Text size={13} tone="danger">{` · ${details[1]}`}</Text>
          ) : null}
        </Text>
      </View>
      <ChevronRight size={16} color={theme.muted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Prototype `.strip`: padding 7px 14px, gap 8px, 13px text, bottom border.
  strip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 7,
    paddingHorizontal: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    minHeight: 36,
  },
  text: { flex: 1, minWidth: 0 },
});
