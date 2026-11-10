import { StyleSheet, View, useColorScheme } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";
import {
  MASCOT_BOLD_FEET_BELOW,
  mascot,
  mascotColors,
  radius,
} from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { Text } from "./Text";

// Share of the plate the mascot occupies; matches the web Logo.
const MASCOT_SHARE = 0.7;

/** Coma's mascot, or the workspace initial when a workspace name is supplied. */
export function WorkspaceMark({
  name,
  size = 48,
}: {
  name: string;
  size?: number;
}) {
  const theme = useTheme();
  const colors = mascotColors[useColorScheme() === "dark" ? "dark" : "light"];
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
          backgroundColor: coma ? colors.plate : theme.sidebar,
          borderWidth: 1,
          borderColor: theme.border,
        },
      ]}
    >
      {coma ? (
        <Mascot height={size * MASCOT_SHARE} colors={colors} />
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

function Mascot({
  height,
  colors,
}: {
  height: number;
  colors: (typeof mascotColors)[keyof typeof mascotColors];
}) {
  const feet = height < MASCOT_BOLD_FEET_BELOW ? "bold" : "regular";
  const box = mascot.viewBox[feet];
  return (
    <Svg
      width={(height * box.width) / box.height}
      height={height}
      viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`}
    >
      {mascot.feet[feet].map(([x, y, width, rectHeight]) => (
        <Rect
          key={x}
          x={x}
          y={y}
          width={width}
          height={rectHeight}
          fill={colors.feet}
        />
      ))}
      <Path d={mascot.body} fill={colors.body} />
      {mascot.eyes.map(([x, y, width, rectHeight]) => (
        <Rect
          key={x}
          x={x}
          y={y}
          width={width}
          height={rectHeight}
          fill={colors.eyes}
        />
      ))}
    </Svg>
  );
}

const styles = StyleSheet.create({
  mark: { alignItems: "center", justifyContent: "center" },
});
