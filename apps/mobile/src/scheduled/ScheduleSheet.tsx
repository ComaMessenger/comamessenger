import { useEffect, useMemo, useState } from "react";
import {
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  View,
  useColorScheme,
} from "react-native";
import DateTimePicker, {
  DateTimePickerAndroid,
  type DateTimePickerEvent,
} from "@react-native-community/datetimepicker";
import { useTranslation } from "react-i18next";
import { BellOff } from "lucide-react-native";
import {
  scheduleHorizonMs,
  schedulePresets,
  scheduleProblem,
  type SchedulePreset,
  type SchedulePresetID,
} from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { BottomSheet } from "@/ui/BottomSheet";
import { Button } from "@/ui/Button";
import { Text } from "@/ui/Text";
import { useClock, useNow, useWhen } from "./clock";
import {
  combine,
  dayDistance,
  formatDate,
  formatTime,
  formatWeekdayShort,
  type Clock,
} from "./format";

type Selection =
  | { kind: "choice"; key: SchedulePresetID }
  | { kind: "custom"; at: Date };

const choiceLabel: Record<SchedulePresetID, string> = {
  inHour: "scheduledChoiceInHour",
  thisEvening: "scheduledChoiceTonight",
  tomorrowMorning: "scheduledChoiceTomorrow",
  nextMonday: "scheduledChoiceMonday",
};

function defaultCustom(now: Date): Date {
  const tomorrow = schedulePresets(now).find(
    (preset) => preset.id === "tomorrowMorning",
  );
  return tomorrow?.at ?? new Date(now.getTime() + 60 * 60_000);
}

/**
 * «Send later»: four ready-made times and a custom date and time from the
 * native pickers, and «Without sound» as on the web. The button repeats the
 * chosen moment. Times are on the device clock and in its time zone.
 */
export function ScheduleSheet({
  visible,
  title,
  confirmKey = "scheduledConfirm",
  initial = null,
  initialSilent = false,
  pending = false,
  onConfirm,
  onClose,
}: {
  visible: boolean;
  title: string;
  /** «Запланировать: …» or «Перенести: …». */
  confirmKey?: "scheduledConfirm" | "scheduledMoveConfirm";
  /** The current time of a record being moved. */
  initial?: Date | null;
  /** The quiet flag of a record being moved. */
  initialSilent?: boolean;
  pending?: boolean;
  onConfirm(at: Date, silent: boolean): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const scheme = useColorScheme();
  const clock = useClock();
  const when = useWhen();
  const now = useNow(30_000, visible);
  const choices = useMemo(() => schedulePresets(now), [now]);
  const [selection, setSelection] = useState<Selection>({
    kind: "choice",
    key: "tomorrowMorning",
  });
  const [silent, setSilent] = useState(initialSilent);
  const [custom, setCustom] = useState(() => defaultCustom(new Date()));

  // Each opening starts from the record's time or from «tomorrow morning».
  // Keyed by the time value: callers pass a new Date object on every render.
  const initialTime = initial ? initial.getTime() : null;
  useEffect(() => {
    if (!visible) return;
    const opened = new Date();
    const start = initialTime === null ? null : new Date(initialTime);
    setSilent(initialSilent);
    if (start && !scheduleProblem(start, opened)) {
      setCustom(start);
      setSelection({ kind: "custom", at: start });
    } else {
      setCustom(defaultCustom(opened));
      setSelection({ kind: "choice", key: "tomorrowMorning" });
    }
  }, [initialSilent, initialTime, visible]);

  const chosen =
    selection.kind === "custom"
      ? selection.at
      : (choices.find((choice) => choice.id === selection.key)?.at ?? null);
  const problem = chosen ? scheduleProblem(chosen, now) : "past";
  const maximum = new Date(now.getTime() + scheduleHorizonMs);

  function pickCustom(at: Date) {
    setCustom(at);
    setSelection({ kind: "custom", at });
  }

  function onPicked(part: "date" | "time") {
    return (event: DateTimePickerEvent, picked?: Date) => {
      if (event.type !== "set" || !picked) return;
      pickCustom(
        part === "date" ? combine(picked, custom) : combine(custom, picked),
      );
    };
  }

  function openAndroid(part: "date" | "time") {
    DateTimePickerAndroid.open({
      value: custom,
      mode: part,
      is24Hour: !clock.hour12,
      ...(part === "date" ? { minimumDate: now, maximumDate: maximum } : {}),
      onChange: onPicked(part),
    });
  }

  const customSelected = selection.kind === "custom";
  return (
    <BottomSheet
      visible={visible}
      title={title}
      onClose={onClose}
      testID="schedule-sheet"
    >
      <View style={styles.grid} accessibilityRole="radiogroup">
        {choices.map((choice) => {
          const selected =
            selection.kind === "choice" && selection.key === choice.id;
          return (
            <Pressable
              key={choice.id}
              testID={`schedule-choice-${choice.id}`}
              accessibilityRole="radio"
              accessibilityState={{ selected, checked: selected }}
              accessibilityLabel={`${t(choiceLabel[choice.id])}, ${when(choice.at, now)}`}
              onPress={() => setSelection({ kind: "choice", key: choice.id })}
              style={[
                styles.choice,
                {
                  borderColor: selected ? theme.primary : theme.border,
                  backgroundColor: selected ? theme.primarySoft : theme.surface,
                },
              ]}
            >
              <Text weight="semibold" size={15} numberOfLines={1}>
                {t(choiceLabel[choice.id])}
              </Text>
              <Text tone="muted" size={13} numberOfLines={1}>
                {choiceHint(choice, now, clock, t)}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Text tone="muted" weight="semibold" size={12} style={styles.label}>
        {t("scheduledCustom").toLocaleUpperCase()}
      </Text>
      {Platform.OS === "ios" ? (
        <View
          style={[
            styles.iosRow,
            {
              borderColor: customSelected ? theme.primary : theme.borderStrong,
              backgroundColor: customSelected
                ? theme.primarySoft
                : theme.surface,
            },
          ]}
        >
          <DateTimePicker
            testID="schedule-date"
            accessibilityLabel={t("scheduledPickDate")}
            value={custom}
            mode="date"
            display="compact"
            minimumDate={now}
            maximumDate={maximum}
            locale={clock.locale}
            accentColor={theme.primary}
            themeVariant={scheme === "dark" ? "dark" : "light"}
            onChange={onPicked("date")}
          />
          <DateTimePicker
            testID="schedule-time"
            accessibilityLabel={t("scheduledPickTime")}
            value={custom}
            mode="time"
            display="compact"
            locale={clock.locale}
            accentColor={theme.primary}
            themeVariant={scheme === "dark" ? "dark" : "light"}
            onChange={onPicked("time")}
          />
        </View>
      ) : (
        <View style={styles.fields}>
          {(["date", "time"] as const).map((part) => (
            <Pressable
              key={part}
              testID={`schedule-${part}`}
              accessibilityRole="button"
              accessibilityLabel={`${t(part === "date" ? "scheduledPickDate" : "scheduledPickTime")}: ${
                part === "date"
                  ? formatDate(custom, now, clock)
                  : formatTime(custom, clock)
              }`}
              onPress={() => openAndroid(part)}
              style={[
                styles.field,
                part === "date" ? styles.dateField : styles.timeField,
                {
                  borderColor: customSelected
                    ? theme.primary
                    : theme.borderStrong,
                  backgroundColor: theme.surface,
                },
              ]}
            >
              <Text size={16} numberOfLines={1}>
                {part === "date"
                  ? `${formatWeekdayShort(custom, clock)}, ${formatDate(custom, now, clock)}`
                  : formatTime(custom, clock)}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
      {problem && customSelected ? (
        <Text
          tone="danger"
          size={13}
          style={styles.problem}
          accessibilityRole="alert"
        >
          {t(problem === "past" ? "scheduledPast" : "scheduledTooFar")}
        </Text>
      ) : null}
      <Pressable
        testID="schedule-silent"
        accessibilityRole="switch"
        accessibilityLabel={t("scheduledSilentLabel")}
        accessibilityHint={t("scheduledSilentHint")}
        accessibilityState={{ checked: silent }}
        onPress={() => setSilent((value) => !value)}
        style={[
          styles.silent,
          { borderColor: theme.border, backgroundColor: theme.surface },
        ]}
      >
        <BellOff size={18} color={theme.muted} />
        <View style={styles.grow}>
          <Text size={15} weight="medium">
            {t("scheduledSilentLabel")}
          </Text>
          <Text size={12.5} tone="muted">
            {t("scheduledSilentHint")}
          </Text>
        </View>
        <Switch
          importantForAccessibility="no-hide-descendants"
          accessibilityElementsHidden
          value={silent}
          onValueChange={setSilent}
          trackColor={{ true: theme.primary, false: theme.borderStrong }}
        />
      </Pressable>
      <View style={styles.confirm}>
        <Button
          testID="schedule-confirm"
          label={
            chosen && !problem
              ? t(confirmKey, { when: when(chosen, now) })
              : t("scheduledSendLater")
          }
          pending={pending}
          disabled={Boolean(problem) || !chosen}
          onPress={() => chosen && !problem && onConfirm(chosen, silent)}
        />
      </View>
    </BottomSheet>
  );
}

function choiceHint(
  choice: SchedulePreset,
  now: Date,
  clock: Clock,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const time = formatTime(choice.at, clock);
  const distance = dayDistance(choice.at, now);
  if (choice.id === "nextMonday")
    return `${formatDate(choice.at, now, clock)}, ${time}`;
  if (choice.id === "tomorrowMorning" || distance > 0)
    return `${formatWeekdayShort(choice.at, clock)}, ${t("scheduledAtTime", { time })}`;
  return t("scheduledAtTime", { time });
}

const styles = StyleSheet.create({
  // Prototype: `.q2 { grid 1fr 1fr; gap: 8px }`, `.qo { radius 14; padding 10px 12px }`.
  grid: { flexDirection: "row", flexWrap: "wrap", gap: spacing[2] },
  choice: {
    width: "48.5%",
    flexGrow: 1,
    borderWidth: 1,
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  // Prototype: `.lbl { 12px, 600, uppercase, margin: 14px 0 7px }`.
  label: { marginTop: 14, marginBottom: 7, letterSpacing: 0.5 },
  fields: { flexDirection: "row", gap: spacing[2] },
  field: {
    height: 44,
    borderRadius: radius.lg,
    borderWidth: 1,
    justifyContent: "center",
    paddingHorizontal: 13,
  },
  dateField: { flex: 1.4 },
  timeField: { flex: 1 },
  iosRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderRadius: radius.lg,
    borderWidth: 1,
    paddingHorizontal: spacing[2],
    paddingVertical: 4,
    gap: spacing[2],
  },
  problem: { marginTop: spacing[2] },
  silent: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[3],
    marginTop: 14,
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  grow: { flex: 1 },
  confirm: { marginTop: 14 },
});
