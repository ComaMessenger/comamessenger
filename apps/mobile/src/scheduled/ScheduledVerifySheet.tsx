import { ScrollView, StyleSheet, View } from "react-native";
import { Paperclip, ShieldAlert } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { messagePlainText, type ScheduledMessage } from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { BottomSheet } from "@/ui/BottomSheet";
import { Button } from "@/ui/Button";
import { Text } from "@/ui/Text";

export type VerifyAction = "sendNow" | "time";

/**
 * Before sending again or moving a message stopped by a security event
 * (password or e-mail changed, a device signed out): whoever scheduled it may
 * not have been the owner, so the whole text is shown first. The button is
 * deliberately not the primary colour — reading comes before agreeing.
 */
export function ScheduledVerifySheet({
  target,
  onConfirm,
  onClose,
}: {
  target: { item: ScheduledMessage; action: VerifyAction } | null;
  onConfirm(item: ScheduledMessage, action: VerifyAction): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const item = target?.item ?? null;
  const text = item ? messagePlainText(item.body ?? "") : "";
  const files = item?.files ?? [];
  return (
    <BottomSheet
      visible={target !== null}
      title={t("scheduledVerifyTitle")}
      onClose={onClose}
      testID="scheduled-verify-sheet"
    >
      <View
        style={[
          styles.warning,
          {
            backgroundColor: theme.dangerSoft,
            borderColor: theme.dangerBorder,
          },
        ]}
      >
        <ShieldAlert size={18} color={theme.danger} />
        <Text size={14} style={[styles.grow, { color: theme.dangerText }]}>
          {t("scheduledVerifyText")}
        </Text>
      </View>
      <ScrollView
        style={[
          styles.message,
          { borderColor: theme.border, backgroundColor: theme.canvas },
        ]}
        contentContainerStyle={styles.messageContent}
      >
        {text ? (
          <Text testID="scheduled-verify-text" size={15} selectable>
            {text}
          </Text>
        ) : (
          <Text size={15} tone="muted">
            {t("scheduledEmptyBody")}
          </Text>
        )}
        {files.length ? (
          <View style={styles.files}>
            <Paperclip size={14} color={theme.muted} />
            <Text size={13} tone="muted" style={styles.grow}>
              {files.map((file) => file?.name ?? "").join(", ")}
            </Text>
          </View>
        ) : null}
      </ScrollView>
      <View style={styles.buttons}>
        <Button
          testID="scheduled-verify-confirm"
          variant="secondary"
          label={
            target?.action === "time"
              ? t("scheduledVerifyMove")
              : t("scheduledSendNow")
          }
          onPress={() => target && onConfirm(target.item, target.action)}
        />
        <Button variant="ghost" label={t("cancel")} onPress={onClose} />
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  warning: {
    flexDirection: "row",
    gap: spacing[2],
    borderWidth: 1,
    borderRadius: 12,
    padding: spacing[3],
  },
  message: {
    marginTop: spacing[3],
    maxHeight: 280,
    borderWidth: 1,
    borderRadius: radius.lg,
  },
  messageContent: { padding: spacing[3], gap: spacing[2] },
  files: { flexDirection: "row", alignItems: "center", gap: 6 },
  buttons: { marginTop: 14, gap: spacing[2] },
  grow: { flex: 1 },
});
