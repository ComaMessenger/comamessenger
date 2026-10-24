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
              {
                backgroundColor: selected ? theme.surface : theme.sidebar,
                borderColor: selected ? theme.borderStrong : "transparent",
              },
            ]}
          >
            <Text
              weight="medium"
              size={15}
              style={{ color: selected ? theme.primary : theme.muted }}
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
  row: { gap: spacing[1], paddingHorizontal: spacing[4] },
  chip: {
    minHeight: 44,
    paddingVertical: spacing[1],
    paddingHorizontal: spacing[3],
    borderRadius: radius.md,
    borderWidth: 1,
    justifyContent: "center",
  },
});
