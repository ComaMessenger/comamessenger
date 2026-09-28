import { StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { AgentStatusState, ChatMember } from "@comamessenger/core";
import { spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { Avatar } from "@/ui/Avatar";
import { Text } from "@/ui/Text";
import { Markdown } from "./Markdown";

/** Live agent output while a run streams into the feed. */
export function AgentStreamRow({
  body,
  author,
  state,
}: {
  body: string;
  author?: ChatMember;
  state: AgentStatusState["state"];
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const name = author?.display_name ?? t("agent");
  return (
    <View accessibilityLiveRegion="polite" style={styles.row}>
      <Avatar name={name} seed={author?.actor_id ?? "agent"} size={34} agent />
      <View style={styles.content}>
        <View style={styles.meta}>
          <Text
            weight="semibold"
            size={15}
            numberOfLines={1}
            style={styles.shrink}
          >
            {name}
          </Text>
          <View style={[styles.dot, { backgroundColor: theme.online }]} />
          <Text tone="muted" size={13}>
            {t(`agentState_${state}`)}
          </Text>
        </View>
        {body ? <Markdown source={body} /> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
  },
  content: { flex: 1, gap: spacing[1] },
  meta: { flexDirection: "row", alignItems: "center", gap: spacing[2] },
  shrink: { flexShrink: 1 },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
