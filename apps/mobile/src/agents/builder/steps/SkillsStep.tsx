import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { Plug, Plus, ShieldCheck, X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  actionLocked,
  actionMode,
  assignableTools,
  externalMode,
  skillActions,
  skills,
  withActionMode,
  type AgentMcpBinding,
} from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { useSignedIn } from "@/session/SessionProvider";
import { IconButton } from "@/ui/IconButton";
import { PickerSheet } from "@/ui/PickerSheet";
import { ActionRow, Divider, SettingsGroup, SwitchRow } from "@/ui/Settings";
import { Text } from "@/ui/Text";
import { useAgentBuilder } from "../AgentBuilderProvider";
import { ModeChoice, Note } from "../controls";
import { agentKeys } from "../data";
import { StepScreen } from "../StepScreen";

/**
 * Step 4 (web block «Что умеет»): actions in plain language, each with «сам»
 * or «после подтверждения» — «писать людям лично» among them — and the
 * external systems of the workspace. The choice is part of the draft and
 * takes effect when the agent is published; the server keeps its own floor.
 */
export function SkillsStep() {
  const { t } = useTranslation();
  const theme = useTheme();
  const builder = useAgentBuilder();
  const { draft, capabilities, agent, update } = builder;
  const editable = builder.access.canBuild;
  const policy = draft.confirmation_policy;
  return (
    <StepScreen
      step="skills"
      title={t("agentBlockSkills")}
      lead={t("agentBlockSkillsHint")}
    >
      {skills.map((skill) => {
        const checked = capabilities.skills.includes(skill);
        return (
          <SettingsGroup key={skill}>
            <SwitchRow
              testID={`agent-skill-${skill}`}
              label={t(`agentSkill_${skill}`)}
              hint={t(`agentSkillHint_${skill}`)}
              value={checked}
              disabled={!editable}
              onChange={(value) =>
                builder.setCapabilities({
                  ...capabilities,
                  skills: value
                    ? [...capabilities.skills, skill]
                    : capabilities.skills.filter((item) => item !== skill),
                })
              }
            />
            {checked &&
              skillActions[skill].map((action) => {
                const label = t(`agentAction_${action}`);
                const locked = actionLocked(agent.confirmation_locked, action);
                const mode = locked ? "confirm" : actionMode(policy, action);
                return (
                  <View key={action}>
                    <Divider />
                    <View style={styles.action}>
                      <Text size={15} weight="medium">
                        {label}
                      </Text>
                      <Text tone="muted" size={13.5}>
                        {t(
                          mode === "auto"
                            ? "agentActionAutoHint"
                            : "agentActionConfirmHint",
                        )}
                      </Text>
                      {editable || locked ? (
                        <ModeChoice
                          testID={`agent-mode-${action}`}
                          label={label}
                          mode={mode}
                          locked={locked}
                          lockedReason={t("agentActionLockedServer")}
                          onChange={(next) =>
                            update({
                              confirmation_policy: withActionMode(
                                policy,
                                action,
                                next,
                              ),
                            })
                          }
                        />
                      ) : null}
                    </View>
                  </View>
                );
              })}
          </SettingsGroup>
        );
      })}
      <ExternalSystems
        editable={editable}
        bindings={draft.mcp_bindings ?? []}
        onChange={(mcp_bindings) => update({ mcp_bindings })}
      />
      <Note icon={<ShieldCheck size={16} color={theme.muted} />}>
        {t("agentSkillsPolicy")}
      </Note>
    </StepScreen>
  );
}

/**
 * Workspace connections released for agents, the tools the agent may call
 * within the connection policy and, for a tool that changes data, «сам» or
 * «после подтверждения».
 */
function ExternalSystems({
  editable,
  bindings,
  onChange,
}: {
  editable: boolean;
  bindings: AgentMcpBinding[];
  onChange(bindings: AgentMcpBinding[]): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { api } = useSignedIn();
  const [adding, setAdding] = useState(false);
  const connections = useQuery({
    queryKey: agentKeys.mcpConnections,
    queryFn: () => api.mcpConnections(),
    retry: false,
  });
  if (connections.isError) return null;
  const byID = new Map(
    (connections.data ?? []).map((connection) => [connection.id, connection]),
  );
  const available = (connections.data ?? []).filter(
    (connection) =>
      connection.agent_use_allowed &&
      connection.enabled &&
      !bindings.some((binding) => binding.connection_id === connection.id),
  );
  if (bindings.length === 0 && available.length === 0) return null;
  const replace = (index: number, binding: AgentMcpBinding) =>
    onChange(bindings.map((item, at) => (at === index ? binding : item)));
  return (
    <>
      <View style={styles.subhead}>
        <Plug size={18} color={theme.muted} />
        <View style={styles.grow}>
          <Text size={15} weight="semibold">
            {t("agentExternalTitle")}
          </Text>
          <Text tone="muted" size={13.5}>
            {t("agentExternalHint")}
          </Text>
        </View>
      </View>
      {bindings.map((binding, index) => {
        const connection = byID.get(binding.connection_id);
        const requires = connection?.writes_require_confirmation ?? true;
        const tools = connection ? assignableTools(connection) : [];
        const name = connection?.name ?? t("agentExternalMissing");
        return (
          <SettingsGroup key={binding.connection_id}>
            <View style={styles.system}>
              <View style={styles.grow}>
                <Text size={16} weight="semibold">
                  {name}
                </Text>
                {connection?.description ? (
                  <Text tone="muted" size={13.5}>
                    {connection.description}
                  </Text>
                ) : null}
              </View>
              {editable ? (
                <IconButton
                  label={t("agentExternalRemove", { name })}
                  onPress={() =>
                    onChange(bindings.filter((_, at) => at !== index))
                  }
                  icon={(color) => <X size={20} color={color} />}
                />
              ) : null}
            </View>
            {tools.length === 0 ? (
              <>
                <Divider />
                <Text tone="muted" size={14} style={styles.pad}>
                  {t("agentExternalNoTools")}
                </Text>
              </>
            ) : null}
            {tools.map((tool) => {
              const allowed = binding.allowed_tools.includes(tool.name);
              return (
                <View key={tool.name}>
                  <Divider />
                  <SwitchRow
                    label={tool.name}
                    hint={[
                      t(tool.readOnly ? "agentToolReads" : "agentToolWrites"),
                      tool.description,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                    value={allowed}
                    disabled={!editable}
                    onChange={(value) => {
                      const policy = { ...(binding.confirmation_policy ?? {}) };
                      if (!value) delete policy[tool.name];
                      replace(index, {
                        ...binding,
                        allowed_tools: value
                          ? [...binding.allowed_tools, tool.name]
                          : binding.allowed_tools.filter(
                              (item) => item !== tool.name,
                            ),
                        confirmation_policy: policy,
                      });
                    }}
                  />
                  {allowed && !tool.readOnly ? (
                    <View style={styles.toolMode}>
                      <ModeChoice
                        label={tool.name}
                        mode={externalMode(binding, tool.name, requires)}
                        locked={requires}
                        lockedReason={t("agentActionLockedConnection")}
                        onChange={(mode) =>
                          replace(index, {
                            ...binding,
                            confirmation_policy: {
                              ...(binding.confirmation_policy ?? {}),
                              [tool.name]: mode,
                            },
                          })
                        }
                      />
                    </View>
                  ) : null}
                </View>
              );
            })}
          </SettingsGroup>
        );
      })}
      {editable && available.length > 0 ? (
        <SettingsGroup>
          <ActionRow
            testID="agent-external-add"
            icon={Plus}
            label={t("agentExternalAdd")}
            onPress={() => setAdding(true)}
          />
        </SettingsGroup>
      ) : null}
      <PickerSheet
        visible={adding}
        title={t("agentExternalChoose")}
        value=""
        options={available.map((connection) => ({
          value: connection.id,
          label: connection.name,
        }))}
        onSelect={(connection_id) =>
          onChange([
            ...bindings,
            {
              connection_id,
              allowed_tools: [],
              require_write_confirmation: true,
            },
          ])
        }
        onClose={() => setAdding(false)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  action: {
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    gap: spacing[2],
    marginLeft: spacing[3],
  },
  subhead: {
    flexDirection: "row",
    gap: spacing[2],
    alignItems: "flex-start",
    paddingHorizontal: spacing[1],
    marginTop: spacing[2],
    borderRadius: radius.md,
  },
  system: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[2],
    paddingLeft: spacing[4],
    paddingRight: spacing[2],
    paddingVertical: spacing[3],
  },
  toolMode: { paddingHorizontal: spacing[4], paddingBottom: spacing[3] },
  pad: { padding: spacing[4] },
  grow: { flex: 1 },
});
