import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import {
  maxAgentInstructionsLength,
  maxAgentNameLength,
  stepProblems,
  type AgentTone,
} from "@comamessenger/core";
import { spacing } from "@comamessenger/tokens";
import { Avatar } from "@/ui/Avatar";
import { GroupBody, SettingsGroup } from "@/ui/Settings";
import { Text } from "@/ui/Text";
import { TextField } from "@/ui/TextField";
import { useAgentBuilder } from "../AgentBuilderProvider";
import { Chip, ChipRow } from "../controls";
import { StepScreen } from "../StepScreen";

const tones: AgentTone[] = ["concise", "friendly", "formal", ""];

/**
 * Step 1 (web block «Кто он»): the name people see, the task in the agent's
 * own words and the tone. The server turns the tone into a line of the
 * instructions, shown in advanced settings.
 */
export function RoleStep() {
  const { t } = useTranslation();
  const builder = useAgentBuilder();
  const { draft, agent, update } = builder;
  const [tried, setTried] = useState(false);
  const problems = stepProblems("role", draft);
  const problem = (field: string) => {
    const found = problems.find((item) => item.field === field);
    return found ? t(found.key) : undefined;
  };
  const length = (draft.description ?? "").length;
  const editable = builder.access.canBuild;
  return (
    <StepScreen
      step="role"
      title={t("agentBlockIdentity")}
      lead={t("agentBlockIdentityHint")}
      canLeave={() => {
        setTried(true);
        return problems.length === 0;
      }}
    >
      <SettingsGroup>
        <GroupBody>
          <View style={styles.identity}>
            <Avatar
              name={draft.display_name || agent.display_name}
              seed={agent.id}
              actorID={agent.id}
              avatarVersion={agent.avatar_version}
              size={56}
              agent
            />
            <View style={styles.grow}>
              <TextField
                testID="agent-name"
                label={t("agentName")}
                value={draft.display_name}
                editable={editable}
                maxLength={maxAgentNameLength}
                onChangeText={(display_name) => update({ display_name })}
                error={problem("display_name")}
              />
            </View>
          </View>
          <TextField
            testID="agent-task"
            label={t("agentTask")}
            value={draft.description ?? ""}
            editable={editable}
            multiline
            maxLength={maxAgentInstructionsLength}
            placeholder={t("agentTaskPlaceholder")}
            onChangeText={(description) => update({ description })}
            error={
              tried || length > maxAgentInstructionsLength
                ? problem("description")
                : undefined
            }
            hint={t("agentTaskHint", {
              count: maxAgentInstructionsLength - length,
            })}
          />
        </GroupBody>
      </SettingsGroup>
      <SettingsGroup title={t("agentTone")} hint={t("agentToneHint")}>
        <GroupBody>
          <ChipRow>
            {tones.map((tone) => (
              <Chip
                key={tone || "none"}
                testID={`agent-tone-${tone || "none"}`}
                label={t(`agentTone_${tone || "none"}`)}
                selected={(draft.tone ?? "") === tone}
                disabled={!editable}
                onPress={() => update({ tone })}
              />
            ))}
          </ChipRow>
        </GroupBody>
      </SettingsGroup>
      {tried && problems.length > 0 ? (
        <Text tone="danger" size={14} accessibilityRole="alert">
          {t("agentStepFix")}
        </Text>
      ) : null}
    </StepScreen>
  );
}

const styles = StyleSheet.create({
  identity: { flexDirection: "row", alignItems: "flex-end", gap: spacing[3] },
  grow: { flex: 1 },
});
