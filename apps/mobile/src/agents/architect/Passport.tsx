import { Pressable, StyleSheet, View } from "react-native";
import {
  CheckCircle2,
  ChevronRight,
  Circle,
  ShieldCheck,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { passportItems, type Agent } from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { BottomSheet } from "@/ui/BottomSheet";
import { Divider } from "@/ui/Settings";
import { Text } from "@/ui/Text";
import { ProgressBar } from "../builder/controls";
import {
  useChats,
  useCollections,
  useConnections,
  useTimezone,
  useTriggers,
} from "../builder/data";

/** The passport of the saved draft, read from the server. */
export function usePassport(agent: Agent | undefined) {
  const { t } = useTranslation();
  const chats = useChats();
  const connections = useConnections();
  const timezone = useTimezone();
  const triggers = useTriggers(agent?.id);
  const collections = useCollections(
    Boolean(agent?.knowledge_collection_ids?.length),
  );
  const items = passportItems(t, {
    agent,
    chats,
    connections: connections.data ?? [],
    collections: collections.data,
    triggers: triggers.data,
    timezone,
  });
  return { items, done: items.filter((item) => item.body !== null).length };
}

/** The draft as it grows: a line above the conversation that opens the passport. */
export function PassportBar({
  agent,
  onOpen,
}: {
  agent: Agent | undefined;
  onOpen(): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { items, done } = usePassport(agent);
  return (
    <Pressable
      testID="architect-passport-open"
      accessibilityRole="button"
      accessibilityLabel={`${t("passportTitle")}. ${t("passportProgress", { done, total: items.length })}`}
      onPress={onOpen}
      style={({ pressed }) => [
        styles.bar,
        {
          backgroundColor: pressed ? theme.surfaceSelected : theme.surface,
          borderBottomColor: theme.border,
        },
      ]}
    >
      <View style={styles.barText}>
        <View style={styles.row}>
          <Text weight="semibold" size={14.5} style={styles.grow}>
            {t("passportTitle")}
          </Text>
          <Text tone="muted" size={13}>
            {t("passportProgress", { done, total: items.length })}
          </Text>
        </View>
        <ProgressBar
          value={done}
          total={items.length}
          label={t("passportTitle")}
        />
      </View>
      <ChevronRight size={18} color={theme.subtle} />
    </Pressable>
  );
}

export function PassportSheet({
  agent,
  visible,
  onClose,
}: {
  agent: Agent | undefined;
  visible: boolean;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { items } = usePassport(agent);
  return (
    <BottomSheet
      visible={visible}
      title={t("passportTitle")}
      onClose={onClose}
      testID="architect-passport"
    >
      <Text tone="muted" size={14} style={styles.lead}>
        {t("passportLead")}
      </Text>
      {items.map((item, index) => {
        const done = item.body !== null;
        const Icon = done ? CheckCircle2 : Circle;
        return (
          <View key={item.key}>
            {index > 0 && <Divider />}
            <View style={styles.item} testID={`architect-passport-${item.key}`}>
              <Icon size={20} color={done ? theme.successText : theme.subtle} />
              <View style={styles.grow}>
                <Text weight="semibold" size={14.5}>
                  {t(item.title)}
                </Text>
                {done ? (
                  <Text size={14.5}>
                    {item.key === "who" && item.name
                      ? `${item.name} — ${item.body}`
                      : item.body}
                  </Text>
                ) : (
                  <Text tone="subtle" size={14.5} style={styles.empty}>
                    {t("passportEmpty")}
                  </Text>
                )}
                {item.key === "model" && done ? (
                  <Text tone="muted" size={13}>
                    {item.approved
                      ? t("passportApproved")
                      : t("passportApprovalNeeded")}
                  </Text>
                ) : null}
              </View>
            </View>
          </View>
        );
      })}
      {agent ? (
        <View style={[styles.rights, { backgroundColor: theme.sidebar }]}>
          <ShieldCheck size={16} color={theme.muted} />
          <Text tone="muted" size={13.5} style={styles.grow}>
            {t("passportRights")}
          </Text>
        </View>
      ) : null}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  barText: { flex: 1, gap: spacing[1] },
  row: { flexDirection: "row", alignItems: "center" },
  grow: { flex: 1 },
  lead: { paddingHorizontal: spacing[4], paddingBottom: spacing[2] },
  item: {
    flexDirection: "row",
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
  },
  empty: { fontStyle: "italic" },
  rights: {
    flexDirection: "row",
    gap: spacing[2],
    margin: spacing[4],
    padding: spacing[3],
    borderRadius: radius.md,
  },
});
