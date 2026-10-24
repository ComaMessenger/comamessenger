import type { ReactNode } from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Copy,
  CornerUpLeft,
  MessagesSquare,
  Pencil,
  Trash2,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { radius, spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { Text } from "@/ui/Text";
import { quickReactions } from "./reactions";

export type MessageAction = "reply" | "thread" | "copy" | "edit" | "delete";

/** Long-press sheet: quick reactions on top, message actions below. */
export function MessageActions({
  visible,
  canThread,
  canEdit,
  canDelete,
  onReact,
  onAction,
  onClose,
}: {
  visible: boolean;
  canThread: boolean;
  canEdit: boolean;
  canDelete: boolean;
  onReact(emoji: string): void;
  onAction(action: MessageAction): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const item = (
    action: MessageAction,
    label: string,
    icon: ReactNode,
    danger = false,
  ) => (
    <Pressable
      key={action}
      accessibilityRole="menuitem"
      onPress={() => onAction(action)}
      style={({ pressed }) => [
        styles.item,
        pressed && { backgroundColor: theme.surfaceSelected },
      ]}
    >
      {icon}
      <Text size={16} tone={danger ? "danger" : "default"} style={styles.label}>
        {label}
      </Text>
    </Pressable>
  );
  const iconColor = theme.muted;
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("cancel")}
        style={[styles.backdrop, { backgroundColor: theme.overlay }]}
        onPress={onClose}
      />
      <View
        accessibilityRole="menu"
        accessibilityLabel={t("messageActions")}
        style={[
          styles.sheet,
          {
            backgroundColor: theme.surface,
            borderColor: theme.border,
            paddingBottom: insets.bottom + spacing[2],
          },
        ]}
      >
        <View style={[styles.quick, { borderBottomColor: theme.border }]}>
          {quickReactions.map((emoji) => (
            <Pressable
              key={emoji}
              accessibilityRole="button"
              accessibilityLabel={emoji}
              onPress={() => onReact(emoji)}
              style={({ pressed }) => [
                styles.emoji,
                {
                  backgroundColor: pressed
                    ? theme.surfaceSelected
                    : theme.sidebar,
                  borderColor: theme.border,
                },
              ]}
            >
              <Text size={24} allowFontScaling={false}>
                {emoji}
              </Text>
            </Pressable>
          ))}
        </View>
        {item(
          "reply",
          t("reply"),
          <CornerUpLeft size={22} color={iconColor} />,
        )}
        {canThread &&
          item(
            "thread",
            t("replyInThread"),
            <MessagesSquare size={22} color={iconColor} />,
          )}
        {item("copy", t("copyText"), <Copy size={22} color={iconColor} />)}
        {canEdit &&
          item(
            "edit",
            t("editMessage"),
            <Pencil size={22} color={iconColor} />,
          )}
        {canDelete &&
          item(
            "delete",
            t("deleteMessage"),
            <Trash2 size={22} color={theme.danger} />,
            true,
          )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: StyleSheet.absoluteFill,
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingTop: spacing[4],
    borderWidth: 1,
    paddingHorizontal: spacing[2],
  },
  quick: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing[1],
    justifyContent: "space-between",
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[3],
    marginBottom: spacing[2],
    borderBottomWidth: 1,
  },
  emoji: {
    width: 44,
    height: 44,
    borderWidth: 1,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[4],
    minHeight: 52,
    paddingHorizontal: spacing[5],
    borderRadius: radius.md,
  },
  label: { flex: 1 },
});
