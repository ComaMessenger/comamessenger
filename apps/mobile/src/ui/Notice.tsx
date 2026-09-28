import { StyleSheet, View } from "react-native";
import { radius, spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { Button } from "./Button";
import { Text } from "./Text";

/** Inline result of a form action: an error, or a confirmation. */
export function Notice({
  tone = "danger",
  title,
  hint,
  actionLabel,
  onAction,
}: {
  tone?: "danger" | "success" | "neutral";
  title: string;
  hint?: string;
  actionLabel?: string;
  onAction?(): void;
}) {
  const theme = useTheme();
  const colors = {
    danger: { background: theme.dangerSoft, title: theme.danger },
    success: { background: theme.primarySoft, title: theme.success },
    neutral: { background: theme.surface, title: theme.foreground },
  }[tone];
  return (
    <View
      accessibilityRole={tone === "danger" ? "alert" : undefined}
      style={[styles.notice, { backgroundColor: colors.background }]}
    >
      <Text weight="semibold" size={15} style={{ color: colors.title }}>
        {title}
      </Text>
      {hint ? (
        <Text tone="muted" size={14}>
          {hint}
        </Text>
      ) : null}
      {actionLabel && onAction ? (
        <View style={styles.action}>
          <Button variant="secondary" label={actionLabel} onPress={onAction} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  notice: { borderRadius: radius.lg, padding: spacing[4], gap: spacing[1] },
  action: { marginTop: spacing[2] },
});
