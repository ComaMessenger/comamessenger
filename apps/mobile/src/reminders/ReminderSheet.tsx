import { useEffect, useMemo, useState } from "react";
import {
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
  useColorScheme,
} from "react-native";
import DateTimePicker, {
  DateTimePickerAndroid,
  type DateTimePickerEvent,
} from "@react-native-community/datetimepicker";
import { CalendarDays } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  formatReminderWhen,
  reminderAt,
  reminderCustomDays,
  reminderDefaultHour,
  reminderNoteMaxLength,
  reminderPresetHint,
  reminderPresetLabelKeys,
  reminderPresets,
  reminderProblem,
  scheduleHorizonMs,
  type ReminderPresetID,
} from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { BottomSheet } from "@/ui/BottomSheet";
import { Text, fonts, maxTextScale } from "@/ui/Text";
import { useClock, useNow } from "@/scheduled/clock";
import {
  combine,
  formatDate,
  formatTime,
  formatWeekdayShort,
} from "@/scheduled/format";
import { calendarLocale } from "@/requests/locale";
import { Chip, SectionLabel, WideButton } from "@/requests/parts";

type Selection =
  | { kind: "preset"; id: ReminderPresetID }
  | { kind: "custom"; at: Date };

const sameDay = (left: Date, right: Date) =>
  left.getFullYear() === right.getFullYear() &&
  left.getMonth() === right.getMonth() &&
  left.getDate() === right.getDate();

function capitalize(text: string) {
  return text ? text[0]!.toLocaleUpperCase() + text.slice(1) : text;
}

/**
 * «Напомнить мне» about a message: four ready-made times, «Своё время»
 * with the next days and any date, a note only the reader sees, and the
 * button that repeats the chosen moment. Built like «Отправить позже»
 * (ScheduleSheet); the times come from @comamessenger/core, in the device's
 * time zone. Also «Перенести» from «Важные → Напоминания».
 */
export function ReminderSheet({
  visible,
  title,
  initial = null,
  pending = false,
  onConfirm,
  onRemove,
  onClose,
}: {
  visible: boolean;
  title: string;
  /** The reminder being changed or moved. */
  initial?: { at: Date; note: string } | null;
  pending?: boolean;
  onConfirm(at: Date, note: string): void;
  /** «Убрать» in the header, for a reminder that is set. */
  onRemove?(): void;
  onClose(): void;
}) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const scheme = useColorScheme();
  const clock = useClock();
  const locale = calendarLocale(i18n.language);
  const now = useNow(30_000, visible);
  const presets = useMemo(() => reminderPresets(now), [now]);
  const days = useMemo(() => reminderCustomDays(now), [now]);
  const [selection, setSelection] = useState<Selection>({
    kind: "preset",
    id: "tomorrowMorning",
  });
  const [custom, setCustom] = useState(() =>
    reminderAt(new Date(Date.now() + 86_400_000), reminderDefaultHour),
  );
  const [note, setNote] = useState("");

  // Each opening starts from the reminder being changed, or «Завтра утром».
  const initialTime = initial ? initial.at.getTime() : null;
  const initialNote = initial?.note ?? "";
  useEffect(() => {
    if (!visible) return;
    const opened = new Date();
    setNote(initialNote);
    if (
      initialTime !== null &&
      !reminderProblem(new Date(initialTime), opened)
    ) {
      const at = new Date(initialTime);
      setCustom(at);
      setSelection({ kind: "custom", at });
    } else {
      const tomorrow = reminderPresets(opened).find(
        (preset) => preset.id === "tomorrowMorning",
      );
      setCustom(
        tomorrow?.at ??
          reminderAt(
            new Date(opened.getTime() + 86_400_000),
            reminderDefaultHour,
          ),
      );
      setSelection({ kind: "preset", id: "tomorrowMorning" });
    }
  }, [initialNote, initialTime, visible]);

  const chosen =
    selection.kind === "custom"
      ? selection.at
      : (presets.find((preset) => preset.id === selection.id)?.at ?? null);
  const problem = chosen ? reminderProblem(chosen, now, note) : "past";
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
  const otherDay = customSelected && !days.some((day) => sameDay(day, custom));

  return (
    <BottomSheet
      visible={visible}
      title={title}
      onClose={onClose}
      testID="reminder-sheet"
      action={
        onRemove ? { label: t("reminderRemove"), onPress: onRemove } : undefined
      }
    >
      <View style={styles.grid} accessibilityRole="radiogroup">
        {presets.map((preset) => {
          const selected =
            selection.kind === "preset" && selection.id === preset.id;
          return (
            <Pressable
              key={preset.id}
              testID={`reminder-preset-${preset.id}`}
              accessibilityRole="radio"
              accessibilityState={{ selected, checked: selected }}
              accessibilityLabel={`${t(reminderPresetLabelKeys[preset.id])}, ${reminderPresetHint(preset, now, locale)}`}
              onPress={() => setSelection({ kind: "preset", id: preset.id })}
              style={[
                styles.choice,
                {
                  borderColor: selected ? theme.primary : theme.border,
                  backgroundColor: selected ? theme.primarySoft : theme.surface,
                },
              ]}
            >
              <Text weight="semibold" size={15}>
                {t(reminderPresetLabelKeys[preset.id])}
              </Text>
              <Text tone="muted" size={13}>
                {reminderPresetHint(preset, now, locale)}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <SectionLabel>{t("reminderCustom")}</SectionLabel>
      <View style={styles.chips}>
        {days.map((day, index) => {
          const on = customSelected && sameDay(day, custom);
          return (
            <Chip
              key={day.toISOString()}
              testID={`reminder-day-${index}`}
              label={`${capitalize(formatWeekdayShort(day, clock))}, ${day.getDate()}`}
              selected={on}
              onPress={() =>
                pickCustom(
                  combine(
                    day,
                    customSelected
                      ? custom
                      : reminderAt(day, reminderDefaultHour),
                  ),
                )
              }
            />
          );
        })}
        <Chip
          testID="reminder-other-date"
          label={t("reminderOtherDate")}
          selected={otherDay}
          icon={
            <CalendarDays
              size={15}
              color={otherDay ? theme.primary : theme.foreground}
            />
          }
          onPress={() => {
            if (Platform.OS === "android") openAndroid("date");
            else pickCustom(custom);
          }}
        />
      </View>
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
            testID="reminder-date"
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
            testID="reminder-time"
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
              testID={`reminder-${part}`}
              accessibilityRole="button"
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
                  ? `${capitalize(formatWeekdayShort(custom, clock))}, ${formatDate(custom, now, clock)}`
                  : formatTime(custom, clock)}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
      {problem && problem !== "noteTooLong" && customSelected ? (
        <Text
          tone="danger"
          size={13}
          style={styles.problem}
          accessibilityRole="alert"
        >
          {t(problem === "past" ? "reminderPast" : "reminderTooFar")}
        </Text>
      ) : null}

      <SectionLabel>{t("reminderNoteLabel")}</SectionLabel>
      <TextInput
        testID="reminder-note"
        value={note}
        onChangeText={setNote}
        placeholder={t("reminderNotePlaceholder")}
        placeholderTextColor={theme.muted}
        accessibilityLabel={t("reminderNoteLabel")}
        maxLength={reminderNoteMaxLength}
        maxFontSizeMultiplier={maxTextScale}
        style={[
          styles.note,
          {
            color: theme.foreground,
            borderColor: theme.borderStrong,
            backgroundColor: theme.surface,
          },
        ]}
      />

      <WideButton
        testID="reminder-confirm"
        label={
          chosen && !problem
            ? t("reminderConfirm", {
                when: formatReminderWhen(chosen, now, locale),
              })
            : t("reminderConfirmPlain")
        }
        pending={pending}
        disabled={Boolean(problem) || !chosen}
        onPress={() => chosen && !problem && onConfirm(chosen, note.trim())}
        style={styles.confirm}
      />
    </BottomSheet>
  );
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
  chips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginBottom: spacing[2],
  },
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
  // Prototype `.fi`: 42 high, radius 12, 15.5px.
  note: {
    height: 42,
    borderRadius: radius.lg,
    borderWidth: 1,
    paddingHorizontal: 12,
    fontFamily: fonts.regular,
    fontSize: 15.5,
  },
  confirm: { marginTop: 14 },
});
