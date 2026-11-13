import { Pressable, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import type { ChatMember } from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { Avatar } from "@/ui/Avatar";
import { BottomSheet } from "@/ui/BottomSheet";
import { Text } from "@/ui/Text";

/** Agents of the chat to mention: «Позвать агента» from the "+" sheet. */
export function AgentPicker({
  visible,
  agents,
  onPick,
  onClose,
}: {
  visible: boolean;
  agents: ChatMember[];
  onPick(agent: ChatMember): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  return (
    <BottomSheet visible={visible} title={t("chooseAgent")} onClose={onClose}>
      {agents.map((agent) => (
        <Pressable
          key={agent.actor_id}
          accessibilityRole="button"
          accessibilityLabel={agent.display_name}
          onPress={() => onPick(agent)}
          style={({ pressed }) => [
            styles.row,
            pressed && { backgroundColor: theme.surfaceSelected },
          ]}
        >
          <Avatar
            name={agent.display_name}
            seed={agent.actor_id}
            size={36}
            agent
            actorID={agent.actor_id}
            avatarVersion={agent.avatar_version}
          />
          <Text
            weight="semibold"
            size={15.5}
            numberOfLines={1}
            style={styles.name}
          >
            {agent.display_name}
          </Text>
          <Text tone="muted" size={14} numberOfLines={1} style={styles.handle}>
            @{agent.handle}
          </Text>
        </Pressable>
      ))}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[3],
    minHeight: 52,
    paddingHorizontal: spacing[2],
    borderRadius: radius.lg,
  },
  name: { flexShrink: 1 },
  handle: { flexShrink: 1, marginLeft: "auto" },
});
