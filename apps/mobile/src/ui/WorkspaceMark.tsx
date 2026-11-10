import { StyleSheet, View } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";
import { radius } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { Text } from "./Text";

/** Coma's mark, or the workspace initial when a workspace name is supplied. */
export function WorkspaceMark({
  name,
  size = 48,
}: {
  name: string;
  size?: number;
}) {
  const theme = useTheme();
  const coma = name.trim().toLowerCase() === "coma";
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.mark,
        {
          width: size,
          height: size,
          borderRadius: size > 48 ? radius.lg : radius.md,
          backgroundColor: coma ? "transparent" : theme.sidebar,
          borderWidth: coma ? 0 : 1,
          borderColor: theme.border,
        },
      ]}
    >
      {coma ? (
        <Svg
          width={size * 0.8}
          height={size * 0.84}
          viewBox="0 0 255 265"
          fill="none"
        >
          <Path
            d="M240.019.035c2.503-.13 4.739.077 7.059 1.098 3.171 1.396 5.791 4.038 6.894 7.357 1.72 5.176.763 38.805.759 46.033-.011 18.465.564 37.092-.098 55.54-.159 4.143-.546 8.273-1.161 12.372-1.687 11.857-5.424 23.328-11.045 33.903-20.712 38.826-56.454 60.611-100.428 61.811-8.573.202-16.627-.366-25.276-.753-33.035-1.478-68.333 10.521-88.609 37.696-4.145 5.556-5.248 7.777-12.159 9.877-16.953.754-15.89-12.388-15.812-24.48l-.015-18.128-.031-41.519c-.014-7.846-.263-16.998.095-24.681.282-5.92 1.026-11.809 2.227-17.613C14.583 80 65.389 43.144 124.691 46.925c21.396 1.365 42.358 1.211 62.561-7.181 14.508-5.661 27.216-14.681 37.644-26.218 5.64-6.239 5.798-11.89 15.123-13.491Z"
            fill={theme.primary}
          />
          <Circle cx="187.6" cy="133" r="16.2" fill={theme.surface} />
          <Circle cx="127.9" cy="133" r="16.2" fill={theme.surface} />
          <Circle cx="68" cy="133" r="16.2" fill={theme.surface} />
        </Svg>
      ) : (
        <Text
          allowFontScaling={false}
          weight="bold"
          size={Math.round(size * 0.45)}
          style={{ color: theme.muted }}
        >
          {(name.trim()[0] ?? "C").toUpperCase()}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  mark: { alignItems: "center", justifyContent: "center" },
});
