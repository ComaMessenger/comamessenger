import { Text as NativeText, type TextProps } from "react-native";
import { useTheme } from "@/lib/theme";

export const fonts = {
  regular: "Onest_400Regular",
  medium: "Onest_500Medium",
  semibold: "Onest_600SemiBold",
  bold: "Onest_700Bold",
} as const;

export type TextWeight = keyof typeof fonts;
export type TextTone = "default" | "muted" | "subtle" | "primary" | "danger";

/** Onest text in theme colours; custom fonts need a family per weight. */
export function Text({
  weight = "regular",
  tone = "default",
  size = 16,
  style,
  ...props
}: TextProps & { weight?: TextWeight; tone?: TextTone; size?: number }) {
  const theme = useTheme();
  const color = {
    default: theme.foreground,
    muted: theme.muted,
    subtle: theme.subtle,
    primary: theme.primary,
    danger: theme.danger,
  }[tone];
  return (
    <NativeText
      {...props}
      style={[
        {
          fontFamily: fonts[weight],
          fontSize: size,
          lineHeight: Math.round(size * 1.35),
          color,
        },
        style,
      ]}
    />
  );
}
