import { StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import { initialsOf } from "@comamessenger/core";
import { stableAvatarIndex, type ThemeTokens } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { useAvatarSource } from "@/files/sources";
import { Text } from "./Text";

export type Presence = "online" | "away" | "offline";

function paletteColor(theme: ThemeTokens, seed: string): string {
  const key = `avatar${stableAvatarIndex(seed) + 1}` as keyof ThemeTokens;
  return theme[key];
}

export function Avatar({
  name,
  seed,
  size = 48,
  glyph,
  agent = false,
  presence,
  actorID,
  avatarVersion,
}: {
  name: string;
  seed: string;
  size?: number;
  glyph?: string;
  agent?: boolean;
  presence?: Presence;
  /** With a version above zero, the uploaded photo replaces the initials. */
  actorID?: string;
  avatarVersion?: number;
}) {
  const theme = useTheme();
  const photo = useAvatarSource(actorID, avatarVersion);
  const dot = Math.round(size * 0.28);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size }}
    >
      <View
        style={[
          styles.circle,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: agent
              ? theme.foreground
              : paletteColor(theme, seed),
          },
        ]}
      >
        <Text
          weight="semibold"
          size={Math.round(size * 0.36)}
          style={{ color: agent ? theme.canvas : "#ffffff" }}
        >
          {glyph ?? (initialsOf(name) || "?")}
        </Text>
        {photo && (
          <Image
            source={photo}
            cachePolicy="disk"
            transition={120}
            style={[StyleSheet.absoluteFill, { borderRadius: size / 2 }]}
          />
        )}
      </View>
      {presence === "online" && (
        <View
          style={[
            styles.dot,
            {
              width: dot,
              height: dot,
              borderRadius: dot / 2,
              backgroundColor: theme.online,
              borderColor: theme.canvas,
            },
          ]}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  circle: { alignItems: "center", justifyContent: "center" },
  dot: { position: "absolute", right: 0, bottom: 0, borderWidth: 2 },
});
