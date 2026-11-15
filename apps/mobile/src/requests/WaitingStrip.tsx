import { Pressable, StyleSheet, View } from "react-native";
import { Bell } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/lib/theme";
import { Text } from "@/ui/Text";

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
