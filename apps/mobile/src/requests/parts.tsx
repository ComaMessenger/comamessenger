import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Switch,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { Check } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { radius } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { Text } from "@/ui/Text";

/**
 * Small pieces of the «Запрос» and «Напомнить мне» screens, sized as in
 * design/prototypes/workplace (`.lbl`, `.chip`, `.pseg`, `.opt`, `.btn`,
 * `.ackbtn`, `.rq-b`). New files rather than changes to src/ui.
 */

/** The prototype's `.lbl`: 12px, 600, uppercase. */
export function SectionLabel({ children }: { children: string }) {
  return (
    <Text
      tone="muted"
      weight="semibold"
      size={12}
      accessibilityRole="header"
      style={styles.label}
    >
      {children.toLocaleUpperCase()}
    </Text>
  );
}

/** The prototype's `.chip`; `.chip.on` when selected. */
export function Chip({
  label,
  selected,
  icon,
  testID,
  disabled,
  onPress,
}: {
  label: string;
  selected?: boolean;
  icon?: ReactNode;
  testID?: string;
  disabled?: boolean;
  onPress(): void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ selected: Boolean(selected), disabled }}
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        {
          backgroundColor: selected
            ? theme.primarySoft
            : pressed
              ? theme.surfaceSelected
              : theme.surface,
          borderColor: selected ? "transparent" : theme.border,
          opacity: disabled ? 0.5 : 1,
        },
      ]}
    >
      {icon}
      <Text
        size={14}
        weight={selected ? "semibold" : "regular"}
        numberOfLines={1}
        style={{ color: selected ? theme.primary : theme.foreground }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** The prototype's `.pseg`: a segmented control on the selected grey. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  testID,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange(value: T): void;
  testID?: string;
}) {
  const theme = useTheme();
  return (
    <View
      accessibilityRole="tablist"
      style={[styles.segments, { backgroundColor: theme.surfaceSelected }]}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            testID={testID ? `${testID}-${option.value}` : undefined}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => onChange(option.value)}
            style={[
              styles.segment,
              selected && [
                styles.segmentOn,
                { backgroundColor: theme.surface },
              ],
            ]}
          >
            <Text
              size={14}
              weight={selected ? "semibold" : "medium"}
              style={{ color: selected ? theme.foreground : theme.muted }}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** The prototype's `.opt` with a `.tg` switch: a line, a hint and a switch. */
export function ToggleRow({
  label,
  hint,
  value,
  disabled,
  testID,
  onChange,
}: {
  label: string;
  hint?: string;
  value: boolean;
  disabled?: boolean;
  testID?: string;
  onChange(value: boolean): void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      onPress={() => onChange(!value)}
      style={[styles.toggle, disabled && styles.disabled]}
    >
      <View style={styles.grow}>
        <Text size={15}>{label}</Text>
        {hint ? (
          <Text tone="muted" size={13}>
            {hint}
          </Text>
        ) : null}
      </View>
      <Switch
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
        value={value}
        disabled={disabled}
        onValueChange={onChange}
        trackColor={{ true: theme.primary, false: theme.borderStrong }}
      />
    </Pressable>
  );
}

/** The prototype's `.btn.pri` (or `.btn.sec`): a full-width button, 46 high. */
export function WideButton({
  label,
  icon,
  variant = "primary",
  disabled,
  pending,
  testID,
  style,
  onPress,
}: {
  label: string;
  icon?: ReactNode;
  variant?: "primary" | "secondary";
  disabled?: boolean;
  pending?: boolean;
  testID?: string;
  style?: StyleProp<ViewStyle>;
  onPress(): void;
}) {
  const theme = useTheme();
  const primary = variant === "primary";
  const inactive = disabled || pending;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: inactive, busy: pending }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.wide,
        {
          backgroundColor: primary
            ? inactive
              ? theme.primaryDisabled
              : pressed
                ? theme.primaryHover
                : theme.primary
            : pressed
              ? theme.surfaceHover
              : theme.surfaceSelected,
        },
        style,
      ]}
    >
      {pending ? (
        <ActivityIndicator color={primary ? theme.onPrimary : theme.muted} />
      ) : (
        <>
          {icon}
          <Text
            weight="semibold"
            size={16}
            numberOfLines={1}
            style={{
              color: primary
                ? theme.onPrimary
                : inactive
                  ? theme.muted
                  : theme.foreground,
            }}
          >
            {label}
          </Text>
        </>
      )}
    </Pressable>
  );
}

/** The prototype's `.btn.sm`: a small button, 34 high. */
export function SmallButton({
  label,
  icon,
  variant = "secondary",
  disabled,
  testID,
  onPress,
}: {
  label: string;
  icon?: ReactNode;
  variant?: "primary" | "secondary";
  disabled?: boolean;
  testID?: string;
  onPress(): void;
}) {
  const theme = useTheme();
  const primary = variant === "primary";
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.small,
        {
          backgroundColor: primary
            ? pressed
              ? theme.primaryHover
              : theme.primary
            : pressed
              ? theme.surfaceHover
              : theme.surfaceSelected,
          opacity: disabled ? 0.6 : 1,
        },
      ]}
    >
      {icon}
      <Text
        weight="semibold"
        size={14}
        numberOfLines={1}
        style={{ color: primary ? theme.onPrimary : theme.foreground }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * The answer buttons of a request: one big «✓ Ознакомлен(а)» or a row of
 * buttons, the first in the primary colour (`.ackbtn`, `.rq-b`).
 */
export function AnswerButtons({
  options,
  disabled,
  testIDPrefix,
  onAnswer,
}: {
  options: string[];
  disabled?: boolean;
  testIDPrefix?: string;
  onAnswer?(option: number): void;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  if (options.length === 1)
    return (
      <Pressable
        testID={testIDPrefix ? `${testIDPrefix}-0` : undefined}
        accessibilityRole="button"
        accessibilityLabel={t("requestAnswerWith", { option: options[0] })}
        disabled={disabled || !onAnswer}
        onPress={() => onAnswer?.(0)}
        style={({ pressed }) => [
          styles.ack,
          {
            backgroundColor: pressed ? theme.primaryHover : theme.primary,
          },
        ]}
      >
        <Check size={18} color={theme.onPrimary} strokeWidth={2.3} />
        <Text weight="semibold" size={15} style={{ color: theme.onPrimary }}>
          {options[0]}
        </Text>
      </Pressable>
    );
  return (
    <View style={styles.answers}>
      {options.map((option, index) => (
        <Pressable
          key={`${index}-${option}`}
          testID={testIDPrefix ? `${testIDPrefix}-${index}` : undefined}
          accessibilityRole="button"
          accessibilityLabel={t("requestAnswerWith", { option })}
          disabled={disabled || !onAnswer}
          onPress={() => onAnswer?.(index)}
          style={({ pressed }) => [
            styles.answer,
            {
              backgroundColor:
                index === 0
                  ? pressed
                    ? theme.primaryHover
                    : theme.primary
                  : pressed
                    ? theme.surfaceHover
                    : theme.surfaceSelected,
            },
          ]}
        >
          <Text
            weight="semibold"
            size={14}
            numberOfLines={1}
            style={{
              color: index === 0 ? theme.onPrimary : theme.foreground,
            }}
          >
            {option}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

/** A small rounded mark: due date, «Закрыт» (`.pill`, `.pill.wr`). */
export function Pill({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: "neutral" | "warning";
}) {
  const theme = useTheme();
  const warning = tone === "warning";
  return (
    <View
      style={[
        styles.pill,
        {
          backgroundColor: warning ? theme.warningSoft : theme.surfaceSelected,
        },
      ]}
    >
      <Text
        weight="bold"
        size={11.5}
        numberOfLines={1}
        style={{ color: warning ? theme.warning : theme.muted }}
      >
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  label: { marginTop: 14, marginBottom: 7, letterSpacing: 0.5 },
  chip: {
    height: 34,
    paddingHorizontal: 12,
    borderRadius: 17,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  segments: { flexDirection: "row", padding: 3, borderRadius: 12, gap: 2 },
  segment: {
    flex: 1,
    minHeight: 36,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 6,
  },
  segmentOn: {
    shadowColor: "#000000",
    shadowOpacity: 0.12,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  toggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 7,
  },
  disabled: { opacity: 0.5 },
  grow: { flex: 1, minWidth: 0 },
  wide: {
    height: 46,
    borderRadius: radius.button,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingHorizontal: 16,
  },
  small: {
    height: 34,
    borderRadius: 10,
    paddingHorizontal: 13,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
  },
  ack: {
    marginTop: 8,
    height: 40,
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  answers: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 },
  answer: {
    flexGrow: 1,
    flexBasis: 80,
    height: 34,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 10,
  },
  pill: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 9,
  },
});
