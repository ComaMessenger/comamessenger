import { Pressable, ScrollView, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import { systemChatFilters, type SystemChatFilter } from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { Text } from "@/ui/Text";

const labels: Record<SystemChatFilter, string> = {
  all: "filterAll",
  direct: "filterDirect",
  grouped: "filterGroups",
  channel: "filterChannels",
};

export function ChatFilters({
  value,
  onChange,
}: {
  value: SystemChatFilter;
  onChange(value: SystemChatFilter): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
      accessibilityRole="tablist"
    >
      {systemChatFilters.map((filter) => {
        const selected = filter === value;
        return (
          <Pressable
            key={filter}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => onChange(filter)}
            style={[
              styles.chip,
              { backgroundColor: selected ? theme.primary : theme.sidebar },
            ]}
          >
            <Text
              weight="medium"
              size={15}
              style={{ color: selected ? theme.onPrimary : theme.foreground }}
            >
              {t(labels[filter])}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: { gap: spacing[2], paddingHorizontal: spacing[4] },
  chip: {
    minHeight: 36,
    paddingVertical: spacing[1],
    paddingHorizontal: spacing[4],
    borderRadius: radius.full,
    justifyContent: "center",
  },
});
