import {
  Platform,
  Pressable,
  StyleSheet,
  View,
  useColorScheme,
} from "react-native";
import DateTimePicker, {
  DateTimePickerAndroid,
  type DateTimePickerEvent,
} from "@react-native-community/datetimepicker";
import { X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { useClock } from "@/scheduled/clock";
import { Text } from "@/ui/Text";

/** "09:30" → a Date today at that time (the picker's value). */
function timeToDate(value: string): Date {
  const [hours = 0, minutes = 0] = value.split(":").map(Number);
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  return date;
}

function dateToTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** "2026-11-14" ↔ a local Date at midnight. */
function dayToDate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return value ? new Date(year!, month! - 1, day!) : new Date();
}

function dateToDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * A settings row with a time or a date on the right: the compact system
 * picker on iOS, a button opening the system dialog on Android.
 */
function PickerRow({
  label,
  mode,
  value,
  display,
  onChange,
  onClear,
  testID,
}: {
  label: string;
  mode: "time" | "date";
  value: Date | null;
  display: string;
  onChange(value: Date): void;
  onClear?: () => void;
  testID?: string;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const scheme = useColorScheme();
  const clock = useClock();
  const changed = (event: DateTimePickerEvent, picked?: Date) => {
    if (event.type === "set" && picked) onChange(picked);
  };
  return (
    <View style={styles.row} testID={testID}>
      <Text size={16} style={styles.grow}>
        {label}
      </Text>
      {Platform.OS === "ios" && value ? (
        <DateTimePicker
          testID={testID ? `${testID}-picker` : undefined}
          accessibilityLabel={label}
          value={value}
          mode={mode}
          display="compact"
          locale={clock.locale}
          accentColor={theme.primary}
          themeVariant={scheme === "dark" ? "dark" : "light"}
          onChange={changed}
        />
      ) : (
        <Pressable
          testID={testID ? `${testID}-button` : undefined}
          accessibilityRole="button"
          accessibilityLabel={`${label}: ${display}`}
          hitSlop={8}
          onPress={() =>
            Platform.OS === "ios"
              ? onChange(new Date())
              : DateTimePickerAndroid.open({
                  value: value ?? new Date(),
                  mode,
                  is24Hour: !clock.hour12,
                  onChange: changed,
                })
          }
          style={styles.button}
        >
          <Text tone={value ? "default" : "primary"} size={16}>
            {display}
          </Text>
        </Pressable>
      )}
      {onClear && value ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("clearValue", { field: label })}
          hitSlop={8}
          onPress={onClear}
          style={styles.clear}
        >
          <X size={18} color={theme.subtle} />
        </Pressable>
      ) : null}
    </View>
  );
}

/** «HH:MM» in the 24-hour form the server stores. */
export function TimeRow({
  label,
  value,
  onChange,
  testID,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  testID?: string;
}) {
  return (
    <PickerRow
      testID={testID}
      label={label}
      mode="time"
      value={timeToDate(value)}
      display={value}
      onChange={(date) => onChange(dateToTime(date))}
    />
  );
}

/** A day as «YYYY-MM-DD», or empty for «any». */
export function DateRow({
  label,
  value,
  emptyLabel,
  onChange,
  testID,
}: {
  label: string;
  value: string;
  emptyLabel: string;
  onChange(value: string): void;
  testID?: string;
}) {
  const { i18n } = useTranslation();
  const date = value ? dayToDate(value) : null;
  return (
    <PickerRow
      testID={testID}
      label={label}
      mode="date"
      value={date}
      display={
        date
          ? new Intl.DateTimeFormat(i18n.language, {
              dateStyle: "medium",
            }).format(date)
          : emptyLabel
      }
      onChange={(picked) => onChange(dateToDay(picked))}
      onClear={() => onChange("")}
    />
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[3],
    minHeight: 52,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[1],
  },
  grow: { flex: 1 },
  button: { minHeight: 44, justifyContent: "center" },
  clear: {
    minHeight: 44,
    minWidth: 32,
    alignItems: "center",
    justifyContent: "center",
  },
});
