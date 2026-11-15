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
import { CalendarDays } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { radius, spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { Text } from "@/ui/Text";
import { useClock } from "@/scheduled/clock";
import { combine, formatDate, formatTime } from "@/scheduled/format";

/**
 * «Другая дата» of the poll and away sheets: the system date and time
 * pickers in a row on iOS (compact), a tappable line that opens the date
 * and then the time dialog on Android. `dateOnly` asks for a day (a
 * vacation is set in whole days); the caller turns it into a moment.
 */
export function DateTimeRow({
  value,
  minimum,
  maximum,
  dateOnly = false,
  testID,
  onChange,
}: {
  value: Date;
  minimum?: Date;
  maximum?: Date;
  dateOnly?: boolean;
  testID?: string;
  onChange(value: Date): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const scheme = useColorScheme();
  const clock = useClock();

  function picked(part: "date" | "time") {
    return (event: DateTimePickerEvent, next?: Date) => {
      if (event.type !== "set" || !next) return;
      onChange(part === "date" ? combine(next, value) : combine(value, next));
    };
  }

  function openAndroid() {
    DateTimePickerAndroid.open({
      value,
      mode: "date",
      minimumDate: minimum,
      maximumDate: maximum,
      onChange: (event, day) => {
        if (event.type !== "set" || !day) return;
        const chosen = combine(day, value);
        if (dateOnly) {
          onChange(chosen);
          return;
        }
        DateTimePickerAndroid.open({
          value: chosen,
          mode: "time",
          is24Hour: !clock.hour12,
          onChange: (timeEvent, time) =>
            onChange(
              timeEvent.type === "set" && time ? combine(chosen, time) : chosen,
            ),
        });
      },
    });
  }

  if (Platform.OS === "android")
    return (
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={t("scheduledPickDate")}
        onPress={openAndroid}
        style={[
          styles.row,
          { borderColor: theme.primary, backgroundColor: theme.primarySoft },
        ]}
      >
        <CalendarDays size={16} color={theme.primary} />
        <Text size={15} style={{ color: theme.primary }}>
          {dateOnly
            ? formatDate(value, new Date(), clock)
            : `${formatDate(value, new Date(), clock)}, ${formatTime(value, clock)}`}
        </Text>
      </Pressable>
    );

  return (
    <View
      testID={testID}
      style={[
        styles.row,
        styles.ios,
        { borderColor: theme.primary, backgroundColor: theme.primarySoft },
      ]}
    >
      <DateTimePicker
        testID={testID ? `${testID}-date` : undefined}
        accessibilityLabel={t("scheduledPickDate")}
        value={value}
        mode="date"
        display="compact"
        minimumDate={minimum}
        maximumDate={maximum}
        locale={clock.locale}
        accentColor={theme.primary}
        themeVariant={scheme === "dark" ? "dark" : "light"}
        onChange={picked("date")}
      />
      {dateOnly ? null : (
        <DateTimePicker
          testID={testID ? `${testID}-time` : undefined}
          accessibilityLabel={t("scheduledPickTime")}
          value={value}
          mode="time"
          display="compact"
          locale={clock.locale}
          accentColor={theme.primary}
          themeVariant={scheme === "dark" ? "dark" : "light"}
          onChange={picked("time")}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[2],
    borderRadius: radius.lg,
    borderWidth: 1,
    paddingHorizontal: spacing[3],
    paddingVertical: 10,
    marginTop: spacing[2],
  },
  ios: {
    justifyContent: "space-between",
    paddingHorizontal: spacing[2],
    paddingVertical: 4,
  },
});
