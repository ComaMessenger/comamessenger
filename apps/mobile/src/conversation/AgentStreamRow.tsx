import { StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { AgentStatusState, ChatMember } from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { Avatar } from "@/ui/Avatar";
import { Text } from "@/ui/Text";
import { Markdown } from "./Markdown";
import { bubbleCorners } from "./bubbles";

/** Live agent output while a run streams into the feed, as an incoming bubble. */
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
      <Avatar
        name={name}
        seed={author?.actor_id ?? "agent"}
        size={30}
        agent
        actorID={author?.actor_id}
        avatarVersion={author?.avatar_version}
      />
      <View
        style={[
          styles.bubble,
          bubbleCorners({ own: false, first: true }, radius.bubble, radius.sm),
          { borderColor: theme.border, backgroundColor: theme.surface },
        ]}
      >
        <View style={styles.meta}>
          <Text
            weight="semibold"
            size={12.5}
            numberOfLines={1}
            tone="primary"
            style={styles.shrink}
          >
            {name}
          </Text>
          <View style={[styles.dot, { backgroundColor: theme.online }]} />
          <Text tone="muted" size={12}>
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
    alignItems: "flex-end",
    gap: 7,
    paddingHorizontal: 10,
    marginTop: 6,
    maxWidth: "86%",
  },
  bubble: {
    flexShrink: 1,
    gap: spacing[1],
    borderWidth: 1,
    paddingHorizontal: 11,
    paddingTop: 7,
    paddingBottom: 8,
  },
  meta: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: spacing[1],
  },
  shrink: { flexShrink: 1 },
  dot: { width: 6, height: 6, borderRadius: 3 },
});
