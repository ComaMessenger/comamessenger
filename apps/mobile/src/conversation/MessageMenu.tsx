import { Fragment, type ReactNode } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Copy,
  CornerUpLeft,
  Eye,
  Forward,
  Link2,
  MessagesSquare,
  Pencil,
  Pin,
  PinOff,
  Star,
  StarOff,
  Trash2,
  type LucideIcon,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { radius, spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { Text } from "@/ui/Text";
import type { MessageMenuAction } from "./menuItems";
import { quickReactions } from "./reactions";

const items: Record<
  MessageMenuAction,
  { icon: LucideIcon; label: string; danger?: boolean }
> = {
  reply: { icon: CornerUpLeft, label: "reply" },
  thread: { icon: MessagesSquare, label: "replyInThread" },
  save: { icon: Star, label: "addToImportant" },
  unsave: { icon: StarOff, label: "removeFromImportant" },
  pin: { icon: Pin, label: "pinMessage" },
  unpin: { icon: PinOff, label: "unpinMessage" },
  forward: { icon: Forward, label: "forwardMessage" },
  details: { icon: Eye, label: "viewsAndReactions" },
  copyLink: { icon: Link2, label: "copyLink" },
  copyText: { icon: Copy, label: "copyText" },
  edit: { icon: Pencil, label: "messageEdit" },
  delete: { icon: Trash2, label: "deleteMessage", danger: true },
};

/**
 * Long-press menu: the background dims, the message stays in sight above a
 * card with quick reactions and the actions in the web client's order.
 */
export function MessageMenu({
  visible,
  own,
  preview,
  sections,
  canReact,
  ownReactions,
  onReact,
  onAction,
  onClose,
}: {
  visible: boolean;
  /** Lines the card up with the reader's own bubble on the right. */
  own: boolean;
  /** A still copy of the message. */
  preview: ReactNode;
  sections: MessageMenuAction[][];
  canReact: boolean;
  /** Emoji the reader has already put on the message. */
  ownReactions: string[];
  onReact(emoji: string): void;
  onAction(action: MessageMenuAction): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("close")}
        style={[StyleSheet.absoluteFill, { backgroundColor: theme.overlay }]}
        onPress={onClose}
      />
      <View
        pointerEvents="box-none"
        style={[
          styles.stage,
          {
            paddingTop: insets.top + spacing[3],
            paddingBottom: insets.bottom + spacing[5],
            alignItems: own ? "flex-end" : "flex-start",
          },
        ]}
      >
        <ScrollView
          style={styles.preview}
          contentContainerStyle={styles.previewContent}
          bounces={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          {preview}
        </ScrollView>
        <View
          testID="message-menu"
          accessibilityViewIsModal
          accessibilityRole="menu"
          accessibilityLabel={t("messageActions")}
          style={[
            styles.card,
            {
              backgroundColor: theme.surfaceRaised,
              borderColor: theme.border,
            },
          ]}
        >
          {canReact && (
            <View style={[styles.quick, { borderBottomColor: theme.border }]}>
              {quickReactions.map((emoji) => {
                const mine = ownReactions.includes(emoji);
                return (
                  <Pressable
                    key={emoji}
                    accessibilityRole="button"
                    accessibilityLabel={emoji}
                    accessibilityState={{ selected: mine }}
                    onPress={() => onReact(emoji)}
                    style={({ pressed }) => [
                      styles.emoji,
                      {
                        backgroundColor: mine
                          ? theme.primarySoft
                          : pressed
                            ? theme.surfaceSelected
                            : "transparent",
                      },
                    ]}
                  >
                    <Text size={22} allowFontScaling={false}>
                      {emoji}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          )}
          {sections.map((section, index) => (
            <Fragment key={section.join()}>
              {index > 0 && (
                <View
                  style={[styles.divider, { backgroundColor: theme.border }]}
                />
              )}
              {section.map((action) => {
                const item = items[action];
                const Icon = item.icon;
                const color = item.danger ? theme.danger : theme.muted;
                return (
                  <Pressable
                    key={action}
                    testID={`message-action-${action}`}
                    accessibilityRole="menuitem"
                    onPress={() => onAction(action)}
                    style={({ pressed }) => [
                      styles.item,
                      pressed && { backgroundColor: theme.surfaceSelected },
                    ]}
                  >
                    <Icon size={19} color={color} />
                    <Text
                      size={15}
                      tone={item.danger ? "danger" : "default"}
                      style={styles.label}
                    >
                      {t(item.label)}
                    </Text>
                  </Pressable>
                );
              })}
            </Fragment>
          ))}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  stage: { flex: 1, justifyContent: "flex-end", gap: spacing[2] },
  preview: { flexGrow: 0, flexShrink: 1, alignSelf: "stretch" },
  previewContent: { flexGrow: 1, justifyContent: "flex-end" },
  card: {
    width: 272,
    maxWidth: "94%",
    marginHorizontal: 10,
    borderWidth: 1,
    borderRadius: radius.bubble,
    padding: 5,
  },
  quick: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 3,
    paddingTop: 3,
    paddingBottom: spacing[2],
    marginBottom: spacing[1],
    borderBottomWidth: 1,
  },
  emoji: {
    width: 40,
    height: 40,
    borderRadius: radius.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[3],
    minHeight: 44,
    paddingHorizontal: 10,
    borderRadius: 10,
  },
  label: { flex: 1 },
  divider: { height: 1, marginVertical: spacing[1] },
});
