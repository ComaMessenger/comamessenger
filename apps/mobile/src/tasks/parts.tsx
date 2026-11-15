import { createContext, useContext } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Check } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { TaskCardView } from "@comamessenger/core";
import { useTheme } from "@/lib/theme";
import { Text } from "@/ui/Text";
import { taskStatusKeys } from "./format";

/**
 * Small pieces of the task screens, sized as in design/prototypes/workplace
 * (`.pill`, `.cb`, `.cli .cb`, `.trow .cb`).
 */

/** The pill of the card head: the status, or red «Просрочена». */
export function TaskPill({ view }: { view: Pick<TaskCardView, "pill"> }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const pill = view.pill;
  const [background, color, label] =
    pill.kind === "overdue"
      ? [theme.dangerSoft, theme.danger, t("taskPillOverdue")]
      : pill.status === "in_progress"
        ? [theme.primarySoft, theme.primary, t(taskStatusKeys[pill.status])]
        : pill.status === "done"
          ? [theme.successSoft, theme.success, t(taskStatusKeys[pill.status])]
          : [
              theme.surfaceSelected,
              theme.muted,
              t(taskStatusKeys[pill.status]),
            ];
  return (
    <View
      testID="task-pill"
      style={[styles.pill, { backgroundColor: background }]}
    >
      <Text weight="bold" size={11.5} numberOfLines={1} style={{ color }}>
        {label}
      </Text>
    </View>
  );
}

/**
 * A checkbox: square for checklist items (`.cli .cb`), round for «Готово»
 * of a whole task (`.trow .cb`). Disabled ones are drawn but not pressable.
 */
export function TaskCheck({
  checked,
  round = false,
  size = 21,
  disabled,
  label,
  testID,
  onPress,
}: {
  checked: boolean;
  round?: boolean;
  size?: number;
  disabled?: boolean;
  label: string;
  testID?: string;
  onPress?(): void;
}) {
  const theme = useTheme();
  const box = [
    styles.check,
    {
      width: size,
      height: size,
      borderRadius: round ? size / 2 : 7,
      backgroundColor: checked ? theme.primary : theme.surface,
      borderColor: checked ? theme.primary : theme.borderStrong,
      opacity: disabled && !checked ? 0.55 : 1,
    },
  ];
  const mark = checked ? (
    <Check size={size * 0.64} strokeWidth={2.6} color={theme.onPrimary} />
  ) : null;
  // Without an action it is a picture: the line around it takes the tap.
  if (!onPress)
    return (
      <View testID={testID} pointerEvents="none" style={box}>
        {mark}
      </View>
    );
  return (
    <Pressable
      testID={testID}
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked, disabled: Boolean(disabled) }}
      disabled={disabled}
      hitSlop={10}
      onPress={onPress}
      style={box}
    >
      {mark}
    </Pressable>
  );
}

/**
 * Jumps to a message of the open chat: the feed provides it, so «из
 * сообщения» and the task list scroll instead of opening the chat again.
 */
export const TaskJumpContext = createContext<
  ((messageID: string) => void) | null
>(null);

export function useTaskJump() {
  return useContext(TaskJumpContext);
}

const styles = StyleSheet.create({
  pill: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 9,
    flexShrink: 0,
  },
  check: {
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
});
