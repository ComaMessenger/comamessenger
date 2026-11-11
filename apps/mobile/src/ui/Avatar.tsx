import { StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import { initialsOf } from "@comamessenger/core";
import { stableAvatarIndex, type ThemeTokens } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { useAvatarSource } from "@/files/sources";
import { Text } from "./Text";

export type Presence = "online" | "away" | "offline";
/** Groups and channels are rounded squares; people and agents are circles. */
export type AvatarShape = "circle" | "square";

export function avatarRadius(size: number, shape: AvatarShape) {
  return shape === "square" ? Math.round(size / 3) : size / 2;
}

/** Background and initials colour of an avatar; names in a group chat reuse the foreground. */
export function avatarColors(theme: ThemeTokens, seed: string) {
  const index = stableAvatarIndex(seed) + 1;
  return {
    surface: theme[`avatarSurface${index}` as keyof ThemeTokens],
    foreground: theme[`avatarForeground${index}` as keyof ThemeTokens],
  };
}

export function Avatar({
  name,
  seed,
  size = 48,
  glyph,
  agent = false,
  presence,
  actorID,
  chatID,
  avatarVersion,
  shape = "circle",
}: {
  name: string;
  seed: string;
  size?: number;
  glyph?: string;
  agent?: boolean;
  presence?: Presence;
  /** With a version above zero, the uploaded photo replaces the initials. */
  actorID?: string;
  /** A group chat or channel image; takes the place of `actorID`. */
  chatID?: string;
  avatarVersion?: number;
  shape?: AvatarShape;
}) {
  const theme = useTheme();
  const photo = useAvatarSource(actorID, avatarVersion, chatID);
  const colors = avatarColors(theme, seed);
  const dot = Math.round(size * 0.28);
  const corner = avatarRadius(size, shape);
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
            borderRadius: corner,
            backgroundColor: agent ? theme.primarySoft : colors.surface,
          },
        ]}
      >
        <Text
          allowFontScaling={false}
          weight="semibold"
          size={Math.round(size * 0.36)}
          style={{ color: agent ? theme.primary : colors.foreground }}
        >
          {glyph ?? (initialsOf(name) || "?")}
        </Text>
        {photo && (
          <Image
            source={photo}
            cachePolicy="disk"
            transition={120}
            style={[StyleSheet.absoluteFill, { borderRadius: corner }]}
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
