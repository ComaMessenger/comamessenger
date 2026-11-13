import { StyleSheet, View } from "react-native";
import type { ChatMember } from "@comamessenger/core";
import { useTheme } from "@/lib/theme";
import { Avatar } from "./Avatar";

/**
 * Overlapping round avatars, e.g. who replied in a thread. Each one is
 * outlined in `ring`, the colour of what the stack sits on.
 */
export function AvatarStack({
  actorIDs,
  members,
  size = 22,
  ring,
}: {
  actorIDs: string[];
  members: ChatMember[];
  size?: number;
  ring?: string;
}) {
  const theme = useTheme();
  const outline = ring ?? theme.surface;
  return (
    <View
      style={styles.stack}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {actorIDs.map((actorID, index) => {
        const member = members.find((item) => item.actor_id === actorID);
        return (
          <View
            key={actorID}
            style={[
              styles.ring,
              {
                backgroundColor: outline,
                borderRadius: size / 2 + 2,
                marginLeft: index === 0 ? 0 : -5,
                zIndex: actorIDs.length - index,
              },
            ]}
          >
            <Avatar
              name={member?.display_name ?? ""}
              seed={actorID}
              size={size}
              agent={member?.type === "agent"}
              actorID={actorID}
              avatarVersion={member?.avatar_version}
            />
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { flexDirection: "row", alignItems: "center" },
  ring: { padding: 2 },
});
