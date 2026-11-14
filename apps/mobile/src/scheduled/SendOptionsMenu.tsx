import type { RefObject } from "react";
import { StyleSheet, View } from "react-native";
import { ArrowUp, BellOff, Clock } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/lib/theme";
import { AnchoredMenu } from "@/ui/AnchoredMenu";

export type SendMode = "later" | "silent";

/**
 * The small menu over the send button after a long press: «Send later» and
 * «Send without sound». It hangs from the button itself (measured, not
 * where the finger was), aligned to its right edge.
 */
export function SendOptionsMenu({
  visible,
  anchorRef,
  onPick,
  onClose,
}: {
  visible: boolean;
  anchorRef: RefObject<View | null>;
  onPick(mode: SendMode): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  return (
    <AnchoredMenu
      visible={visible}
      anchorRef={anchorRef}
      testID="send-options"
      accessibilityLabel={t("scheduledOptionsLabel")}
      onClose={onClose}
      renderAnchor={() => (
        <View style={[styles.send, { backgroundColor: theme.primary }]}>
          <ArrowUp size={20} color={theme.onPrimary} strokeWidth={2.4} />
        </View>
      )}
      items={[
        {
          key: "later",
          label: t("scheduledSendLater"),
          icon: <Clock size={19} color={theme.muted} />,
          testID: "send-options-later",
          onPress: () => onPick("later"),
        },
        {
          key: "silent",
          label: t("scheduledSendSilent"),
          icon: <BellOff size={19} color={theme.muted} />,
          testID: "send-options-silent",
          onPress: () => onPick("silent"),
        },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  send: {
    flex: 1,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
});
