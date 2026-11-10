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
    success: { background: theme.successSoft, title: theme.successText },
    neutral: { background: theme.sidebar, title: theme.foreground },
  }[tone];
  return (
    <View
      accessibilityRole={tone === "danger" ? "alert" : undefined}
      style={[
        styles.notice,
        {
          backgroundColor: colors.background,
          borderColor:
            tone === "danger"
              ? theme.dangerBorder
              : tone === "success"
                ? theme.successBorder
                : theme.border,
        },
      ]}
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
  notice: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    padding: spacing[3],
    gap: spacing[1],
  },
  action: { marginTop: spacing[2] },
});
