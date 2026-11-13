import { StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import { Bot } from "lucide-react-native";
import { initialsOf } from "@comamessenger/core";
import { stableAvatarIndex, type ThemeTokens } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { useAvatarSource } from "@/files/sources";
import { Text } from "@/ui/Text";

function paletteColors(theme: ThemeTokens, seed: string) {
  const index = stableAvatarIndex(seed) + 1;
  return {
    surface: theme[`avatarSurface${index}` as keyof ThemeTokens],
    foreground: theme[`avatarForeground${index}` as keyof ThemeTokens],
  };
}

/**
 * Avatar of the redesigned lists: groups and channels are rounded squares,
 * people and agents are circles (prototype `.av` / `.av.round`). An agent
 * without a photo shows the bot glyph on the primary tint.
 */
export function ChatAvatar({
  name,
  seed,
  size = 48,
  shape,
  agent = false,
  glyph,
  online = false,
  ringColor,
  actorID,
  chatID,
  avatarVersion,
}: {
  name: string;
  seed: string;
  size?: number;
  shape: "circle" | "square";
  agent?: boolean;
  glyph?: string;
  online?: boolean;
  /** Background behind the avatar; the presence dot is cut out of it. */
  ringColor?: string;
  actorID?: string;
  chatID?: string;
  avatarVersion?: number;
}) {
  const theme = useTheme();
  const photo = useAvatarSource(actorID, avatarVersion, chatID);
  const colors = paletteColors(theme, seed);
  // 48 → 16, 36 → 12, 30 → 10, as in the prototype.
  const corner = shape === "circle" ? size / 2 : Math.round(size / 3);
  const dot = Math.max(10, Math.round(size * 0.27));
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size }}
    >
      <View
        style={[
          styles.face,
          {
            width: size,
            height: size,
            borderRadius: corner,
            backgroundColor: agent ? theme.primarySoft : colors.surface,
          },
        ]}
      >
        {agent ? (
          <Bot size={Math.round(size * 0.46)} color={theme.primary} />
        ) : (
          <Text
            allowFontScaling={false}
            weight="semibold"
            size={Math.round(size / 3)}
            style={{ color: colors.foreground }}
          >
            {glyph ?? (initialsOf(name) || "?")}
          </Text>
        )}
        {photo && (
          <Image
            source={photo}
            cachePolicy="disk"
            transition={120}
            style={[StyleSheet.absoluteFill, { borderRadius: corner }]}
          />
        )}
      </View>
      {online && (
        <View
          style={[
            styles.dot,
            {
              width: dot,
              height: dot,
              borderRadius: dot / 2,
              backgroundColor: theme.online,
              borderColor: ringColor ?? theme.surface,
            },
          ]}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  face: { alignItems: "center", justifyContent: "center", overflow: "hidden" },
  dot: { position: "absolute", right: -2, bottom: -2, borderWidth: 2.5 },
});
