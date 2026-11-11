import {
  Modal,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import { BellOff, Clock } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/lib/theme";
import { Text } from "@/ui/Text";

export type SendMode = "later" | "silent";

/**
 * The small menu over the send button after a long press: «Send later» and
 * «Send without sound». `anchorY` is where the finger was, so the menu sits
 * just above the composer whatever the keyboard does.
 */
export function SendOptionsMenu({
  visible,
  anchorY,
  onPick,
  onClose,
}: {
  visible: boolean;
  anchorY: number | null;
  onPick(mode: SendMode): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { height } = useWindowDimensions();
  // Prototype `.pop`: right 10px, 16px radius, 5px padding, min-width 216px.
  const bottom =
    anchorY !== null && anchorY > 0 ? Math.max(height - anchorY + 28, 80) : 96;
  const items: { mode: SendMode; label: string; Icon: typeof Clock }[] = [
    { mode: "later", label: t("scheduledSendLater"), Icon: Clock },
    { mode: "silent", label: t("scheduledSendSilent"), Icon: BellOff },
  ];
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("close")}
        style={StyleSheet.absoluteFill}
        onPress={onClose}
      />
      <View
        testID="send-options"
        accessibilityViewIsModal
        accessibilityRole="menu"
        accessibilityLabel={t("scheduledOptionsLabel")}
        style={[
          styles.pop,
          {
            bottom,
            backgroundColor: theme.surface,
            borderColor: theme.border,
            boxShadow: theme.shadowFloat,
          },
        ]}
      >
        {items.map(({ mode, label, Icon }) => (
          <Pressable
            key={mode}
            testID={`send-options-${mode}`}
            accessibilityRole="menuitem"
            accessibilityLabel={label}
            onPress={() => onPick(mode)}
            style={({ pressed }) => [
              styles.item,
              pressed && { backgroundColor: theme.surfaceSelected },
            ]}
          >
            <Icon size={19} color={theme.muted} />
            <Text size={15}>{label}</Text>
          </Pressable>
        ))}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  pop: {
    position: "absolute",
    right: 10,
    minWidth: 216,
    borderRadius: 16,
    borderWidth: 1,
    padding: 5,
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 11,
    borderRadius: 11,
    minHeight: 44,
  },
});
