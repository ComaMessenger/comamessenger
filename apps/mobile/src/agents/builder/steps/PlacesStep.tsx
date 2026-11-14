import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { MessagesSquare, Plus, ShieldCheck, X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  chatName,
  chatRole,
  draftChatIDs,
  withChatRole,
  type AgentChatRole as ChatRole,
} from "@comamessenger/core";
import { spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { Avatar } from "@/ui/Avatar";
import { IconButton } from "@/ui/IconButton";
import { ActionRow, Divider, SettingsGroup } from "@/ui/Settings";
import { Text } from "@/ui/Text";
import { useAgentBuilder } from "../AgentBuilderProvider";
import { ChatPickerSheet } from "../ChatPickerSheet";
import { Note, Segmented } from "../controls";
import { StepScreen } from "../StepScreen";

/**
 * Step 2 (web blocks «Где работает» and the chats of «Что знает»): chats of
 * the agent and, for each, whether it reads, writes or both. The server
 * checks both lists on every tool call.
 */
export function PlacesStep() {
  const { t } = useTranslation();
  const theme = useTheme();
  const builder = useAgentBuilder();
  const { draft, chats, update } = builder;
  const [picking, setPicking] = useState(false);
  const ids = draftChatIDs(draft);
  const editable = builder.access.canBuild;
  return (
    <StepScreen
      step="places"
      title={t("agentStepPlaces")}
      lead={t("agentStepPlacesLead")}
    >
      <SettingsGroup
        title={t("agentStepPlacesChats")}
        hint={ids.length ? t("agentChatRoleHint") : undefined}
      >
        {ids.length === 0 ? (
          <View style={styles.empty}>
            <MessagesSquare size={22} color={theme.subtle} />
            <Text tone="muted" size={15} style={styles.grow}>
              {t("agentPlacesEmpty")}
            </Text>
          </View>
        ) : null}
        {ids.map((id, index) => {
          const chat = chats.find((item) => item.id === id);
          const name = chat ? chatName(chat) : t("agentChatHidden");
          return (
            <View key={id}>
              {index > 0 && <Divider />}
              <View style={styles.chat} testID={`agent-place-${name}`}>
                <View style={styles.chatHead}>
                  <Avatar name={name} seed={id} size={36} />
                  <Text
                    size={16}
                    weight="medium"
                    numberOfLines={1}
                    style={styles.grow}
                  >
                    {name}
                  </Text>
                  {editable ? (
                    <IconButton
                      testID={`agent-place-remove-${name}`}
                      label={t("agentPlaceRemove", { name })}
                      onPress={() =>
                        update((current) => withChatRole(current, id, null))
                      }
                      icon={(color) => <X size={20} color={color} />}
                    />
                  ) : null}
                </View>
                {editable ? (
                  <Segmented<ChatRole>
                    testID={`agent-place-role-${name}`}
                    label={t("agentChatRoleLabel", { name })}
                    value={chatRole(draft, id)}
                    onChange={(role) =>
                      update((current) => withChatRole(current, id, role))
                    }
                    items={[
                      { id: "both", label: t("agentChatRole_both") },
                      { id: "read", label: t("agentChatRole_read") },
                      { id: "write", label: t("agentChatRole_write") },
                    ]}
                  />
                ) : (
                  <Text tone="muted" size={14}>
                    {t(`agentChatRole_${chatRole(draft, id)}`)}
                  </Text>
                )}
              </View>
            </View>
          );
        })}
        {editable ? (
          <>
            {ids.length > 0 && <Divider />}
            <ActionRow
              testID="agent-place-add"
              icon={Plus}
              label={t("agentPlaceAdd")}
              onPress={() => setPicking(true)}
            />
          </>
        ) : null}
      </SettingsGroup>
      <Note icon={<ShieldCheck size={16} color={theme.muted} />}>
        {t("agentChatRoleNote")}
      </Note>
      <ChatPickerSheet
        visible={picking}
        title={t("agentPlaceAdd")}
        chats={chats}
        exclude={ids}
        onClose={() => setPicking(false)}
        onDone={(added) =>
          update((current) =>
            added.reduce((next, id) => withChatRole(next, id, "both"), current),
          )
        }
      />
    </StepScreen>
  );
}

const styles = StyleSheet.create({
  empty: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[3],
    padding: spacing[4],
  },
  chat: { padding: spacing[4], paddingRight: spacing[2], gap: spacing[3] },
  chatHead: { flexDirection: "row", alignItems: "center", gap: spacing[3] },
  grow: { flex: 1 },
});
