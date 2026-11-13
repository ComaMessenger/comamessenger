import { Platform, Pressable, StyleSheet, View } from "react-native";
import type { LucideIcon } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { BottomSheet } from "@/ui/BottomSheet";
import { Text } from "@/ui/Text";

/**
 * One tile of the "+" sheet. Media and files are plain tiles; actions in the
 * conversation (calling an agent, scheduling, …) are `accent`. A feature adds
 * its tile with one entry in the list the conversation screen builds.
 */
export type ComposerAction = {
  key: string;
  label: string;
  icon: LucideIcon;
  accent?: boolean;
  onPress(): void;
};

/** The "+" sheet of the composer: a grid of actions, four in a row. */
export function ComposerSheet({
  visible,
  actions,
  onClose,
}: {
  visible: boolean;
  actions: ComposerAction[];
  onClose(): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      testID="composer-sheet"
      accessibilityLabel={t("composerMore")}
    >
      <View style={styles.grid}>
        {actions.map((action) => {
          const Icon = action.icon;
          return (
            <Pressable
              key={action.key}
              testID={`composer-action-${action.key}`}
              accessibilityRole="button"
              accessibilityLabel={action.label}
              onPress={() => {
                onClose();
                // iOS cannot present a system picker while our sheet is still dismissing.
                setTimeout(action.onPress, Platform.OS === "ios" ? 400 : 0);
              }}
              style={({ pressed }) => [styles.tile, pressed && styles.pressed]}
            >
              <View
                style={[
                  styles.icon,
                  {
                    backgroundColor: action.accent
                      ? theme.primarySoft
                      : theme.surfaceSelected,
                  },
                ]}
              >
                <Icon
                  size={24}
                  color={action.accent ? theme.primary : theme.foreground}
                />
              </View>
              <Text
                tone="muted"
                size={12}
                numberOfLines={2}
                style={styles.label}
              >
                {action.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    rowGap: spacing[4],
    paddingBottom: spacing[2],
  },
  tile: { width: "25%", alignItems: "center", gap: 6 },
  pressed: { opacity: 0.7 },
  icon: {
    width: 54,
    height: 54,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  label: { textAlign: "center", paddingHorizontal: 2 },
});
