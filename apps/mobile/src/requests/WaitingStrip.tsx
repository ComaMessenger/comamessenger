import { Pressable, StyleSheet, View } from "react-native";
import { Bell, MessageCircleCheck } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  formatRequestDue,
  type WaitingStrip as Strip,
} from "@comamessenger/core";
import { useTheme } from "@/lib/theme";
import { Text } from "@/ui/Text";
import { useNow } from "@/scheduled/clock";
import { calendarLocale } from "./locale";

/**
 * «Ждут вашего ответа · до пт, 18:00» under the chat header (prototype
 * `.strip.warn`). A tap scrolls to the earliest waiting request. It takes
 * the place of «Отложено» while something waits for the reader.
 */
export function WaitingStrip({
  strip,
  onPress,
}: {
  strip: Strip;
  onPress(): void;
}) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const now = useNow(60_000);
  const due = strip.dueAt
    ? t("requestDueBy", {
        when: formatRequestDue(strip.dueAt, now, calendarLocale(i18n.language)),
      })
    : null;
  const title =
    strip.count > 1
      ? t("requestStripMany", { count: strip.count })
      : t("requestStripOne");
  return (
    <Pressable
      testID="request-waiting-strip"
      accessibilityRole="button"
      accessibilityLabel={[title, due].filter(Boolean).join(", ")}
      accessibilityHint={t("requestStripHint")}
      onPress={onPress}
      style={({ pressed }) => [
        styles.strip,
        {
          backgroundColor: theme.warningSoft,
          borderBottomColor: theme.border,
          opacity: pressed ? 0.8 : 1,
        },
      ]}
    >
      <MessageCircleCheck size={16} color={theme.warning} />
      <View style={styles.text}>
        <Text size={13} numberOfLines={1} style={{ color: theme.warning }}>
          <Text size={13} weight="semibold" style={{ color: theme.warning }}>
            {title}
          </Text>
          {due ? ` · ${due}` : ""}
        </Text>
      </View>
    </Pressable>
  );
}

/**
 * «Напоминание · сообщение подсвечено · Готово» when the chat was opened
 * from a reminder (push or «Важные»), as on phone B of the prototype.
 */
export function ReminderStrip({
  onDone,
  pending,
}: {
  onDone(): void;
  pending?: boolean;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  return (
    <View
      testID="reminder-strip"
      style={[
        styles.strip,
        { backgroundColor: theme.surface, borderBottomColor: theme.border },
      ]}
    >
      <Bell size={16} color={theme.primary} />
      <View style={styles.text}>
        <Text size={13} tone="muted" numberOfLines={1}>
          <Text size={13} weight="semibold">
            {t("reminderStripTitle")}
          </Text>
          {` · ${t("reminderStripHint")}`}
        </Text>
      </View>
      <Pressable
        testID="reminder-strip-done"
        accessibilityRole="button"
        disabled={pending}
        hitSlop={10}
        onPress={onDone}
      >
        <Text tone="primary" weight="semibold" size={14}>
          {t("reminderDone")}
        </Text>
      </Pressable>
    </View>
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
