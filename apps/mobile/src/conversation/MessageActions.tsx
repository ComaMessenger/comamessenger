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
      <Text size={17} tone={danger ? "danger" : "default"}>
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
            paddingBottom: insets.bottom + spacing[2],
          },
        ]}
      >
        <View style={styles.quick}>
          {quickReactions.map((emoji) => (
            <Pressable
              key={emoji}
              accessibilityRole="button"
              accessibilityLabel={emoji}
              onPress={() => onReact(emoji)}
              style={[styles.emoji, { backgroundColor: theme.sidebar }]}
            >
              <Text size={24}>{emoji}</Text>
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
  },
  quick: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[3],
  },
  emoji: {
    width: 48,
    height: 48,
    borderRadius: radius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[4],
    minHeight: 52,
    paddingHorizontal: spacing[5],
  },
});
