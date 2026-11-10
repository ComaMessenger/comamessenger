import { StyleSheet, View } from "react-native";
import { Info } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { MessageAgentProvenance } from "@comamessenger/core";
import { useTheme } from "@/lib/theme";
import { Text } from "@/ui/Text";

/**
 * «Why» under an agent message, as on the web: the kind of trigger and a
 * short label set by the agent's builders.
 */
export function AgentWhy({
  provenance,
}: {
  provenance: MessageAgentProvenance | undefined;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  if (!provenance) return null;
  const reason = t(`acWhy_${provenance.trigger}`, {
    defaultValue: t("acWhy_manual"),
  });
  return (
    <View style={styles.row} testID="agent-why">
      <Info size={13} color={theme.muted} />
      <Text tone="muted" size={12} style={styles.text}>
        {provenance.trigger_label
          ? t("acWhyWithLabel", { reason, label: provenance.trigger_label })
          : reason}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 },
  text: { flexShrink: 1 },
});
