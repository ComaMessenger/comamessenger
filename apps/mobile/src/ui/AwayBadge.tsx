import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import type { AvatarBadge } from "@comamessenger/core";
import { useTheme } from "@/lib/theme";
import { Text } from "./Text";

/**
 * The kind of someone's away status on their avatar instead of the green
 * dot (phase 6.7 decision 9, prototype `.stx`): 🌴, 🩺, 🚗, 🔕 or ⏸ in a
 * small round badge at the bottom right. The avatar components stay as
 * they are: wrap one and pass `online` only for `badge.kind === "online"`.
 */
export function AwayBadge({
  badge,
  size,
  children,
  testID,
}: {
  /** avatarBadge(presence, away, now) of @comamessenger/core. */
  badge: AvatarBadge;
  /** The avatar's size: the badge is about 40 % of it. */
  size: number;
  children: ReactNode;
  testID?: string;
}) {
  const theme = useTheme();
  if (badge?.kind !== "away") return <>{children}</>;
  const mark = Math.max(16, Math.round(size * 0.42));
  const offset = -Math.round(mark * 0.25);
  return (
    <View style={{ width: size, height: size }}>
      {children}
      <View
        testID={testID}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[
          styles.badge,
          {
            width: mark,
            height: mark,
            borderRadius: mark / 2,
            right: offset,
            bottom: offset,
            backgroundColor: theme.surface,
            borderColor: theme.border,
          },
        ]}
      >
        <Text allowFontScaling={false} size={Math.round(mark * 0.6)}>
          {badge.emoji}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    position: "absolute",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
  },
});
