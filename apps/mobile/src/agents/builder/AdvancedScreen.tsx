import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import { Copy, KeyRound, Plus, RotateCcw, Trash2 } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  agentNumberBounds,
  orderedScopes,
  type AgentDraft,
  type AgentNumberField,
} from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { messageOf } from "@/lib/errors";
import { useTheme } from "@/lib/theme";
import { useSignedIn } from "@/session/SessionProvider";
import { SettingsScreen } from "@/settings/SettingsScreen";
import { BottomSheet } from "@/ui/BottomSheet";
import { Button } from "@/ui/Button";
import { Notice } from "@/ui/Notice";
import { ActionRow, Divider, GroupBody, SettingsGroup } from "@/ui/Settings";
import { Text } from "@/ui/Text";
import { TextField } from "@/ui/TextField";
import { useAgentBuilder } from "./AgentBuilderProvider";
import { agentKeys } from "./data";
import { BuilderMessages } from "./StepScreen";

const numberFields: Array<[AgentNumberField, string]> = [
  ["max_output_tokens", "maxOutputTokens"],
  ["max_tool_iterations", "maxToolIterations"],
  ["per_chat_concurrency", "perChatConcurrency"],
  ["rate_limit_per_minute", "rateLimit"],
  ["execution_timeout_seconds", "executionTimeout"],
];

/**
 * Everything technical, as in the web's advanced settings: model, address,
 * limits, the instructions Core builds, the derived permissions, keys,
 * versions, copy, reset and removal.
 */
export function AdvancedScreen() {
  const { t } = useTranslation();
  const builder = useAgentBuilder();
  const { draft, agent, access, update, problems } = builder;
  const editable = access.canBuild;
  const problem = (field: string) => {
    const found = problems.find((item) => item.field === field);
    return found ? t(found.key) : undefined;
  };
  // Numbers are typed as text so a field can be empty while editing.
  const [numbers, setNumbers] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      numberFields.map(([key]) => [key, String(draft[key] ?? "")]),
    ),
  );
  return (
    <SettingsScreen
      title={t("agentAdvancedTitle")}
      subtitle={draft.display_name}
      testID="agent-advanced-screen"
    >
      <BuilderMessages />
      <SettingsGroup title={t("agentAdvancedModel")}>
        <GroupBody>
          <TextField
            label={t("model")}
            value={draft.model ?? ""}
            editable={editable}
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={(model) => update({ model })}
            error={problem("model")}
          />
          <TextField
            testID="agent-handle"
            label={t("agentHandle")}
            value={draft.handle}
            editable={editable}
            autoCapitalize="none"
            autoCorrect={false}
            hint={t("agentHandleHint")}
            onChangeText={(handle) => update({ handle: handle.toLowerCase() })}
            error={problem("handle")}
          />
        </GroupBody>
      </SettingsGroup>
      <SettingsGroup title={t("agentLimits")} hint={t("agentLimitsLead")}>
        <GroupBody>
          {(["daily_cost_limit", "monthly_cost_limit"] as const).map((key) => (
            <TextField
              key={key}
              label={t(
                key === "daily_cost_limit"
                  ? "agentDailyBudget"
                  : "agentMonthlyBudget",
              )}
              value={draft[key] ?? ""}
              editable={editable}
              keyboardType="decimal-pad"
              placeholder={t("agentNoLimit")}
              onChangeText={(value) =>
                update({
                  [key]: value.replace(",", "."),
                } as Partial<AgentDraft>)
              }
              error={problem(key)}
            />
          ))}
          {numberFields.map(([key, label]) => (
            <TextField
              key={key}
              label={t(label)}
              value={numbers[key] ?? ""}
              editable={editable}
              keyboardType="number-pad"
              hint={t("agentNumberRange", {
                min: agentNumberBounds[key][0],
                max: agentNumberBounds[key][1],
              })}
              onChangeText={(value) => {
                const digits = value.replace(/[^0-9]/g, "");
                setNumbers((current) => ({ ...current, [key]: digits }));
                update({
                  [key]: digits === "" ? Number.NaN : Number(digits),
                } as Partial<AgentDraft>);
              }}
              error={problem(key)}
            />
          ))}
        </GroupBody>
      </SettingsGroup>
      <SettingsGroup
        title={t("agentInstructionsTitle")}
        hint={t("agentInstructionsLead")}
      >
        <GroupBody>
          <Text size={14} selectable testID="agent-instructions">
            {agent.instructions ?? agent.description}
          </Text>
        </GroupBody>
      </SettingsGroup>
      <SettingsGroup
        title={t("agentPermissionsTitle")}
        hint={t("agentPermissionsDerived")}
      >
        {orderedScopes
          .filter((scope) => draft.allowed_scopes.includes(scope))
          .map((scope, index) => (
            <View key={scope}>
              {index > 0 && <Divider />}
              <View style={styles.scope}>
                <Text size={13} tone="muted" style={styles.code}>
                  {scope}
                </Text>
                <Text size={14.5}>
                  {t(`agentScope_${scope.replace(":", "_")}`)}
                </Text>
              </View>
            </View>
          ))}
      </SettingsGroup>
      {editable && (agent.kind === "external" || !agent.llm_connection_id) ? (
        <AgentKeys />
      ) : null}
      <VersionHistory />
      {editable ? <DangerZone /> : null}
    </SettingsScreen>
  );
}

/*
 * Keys of an external agent and the legacy per-agent provider key. A shown
 * secret lives only on this screen of this agent.
 */
function AgentKeys() {
  const { t } = useTranslation();
  const theme = useTheme();
  const { api } = useSignedIn();
  const { agent, refetchAgents } = useAgentBuilder();
  const [providerKey, setProviderKey] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState("");
  const keys = useQuery({
    queryKey: agentKeys.keys(agent.id),
    queryFn: () => api.agentKeys(agent.id),
  });
  const credential = useQuery({
    queryKey: ["agent-credential", agent.id],
    queryFn: () => api.agentProviderCredential(agent.id),
    enabled: agent.kind === "builtin" && !agent.llm_connection_id,
  });
  async function act(id: string, work: () => Promise<unknown>) {
    setError("");
    setPending(id);
    try {
      await work();
      await Promise.all([keys.refetch(), refetchAgents()]);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPending("");
    }
  }
  return (
    <SettingsGroup title={t("agentKeysTitle")} hint={t("agentKeysLead")}>
      {agent.kind === "builtin" && !agent.llm_connection_id ? (
        <GroupBody>
          <TextField
            label={t("agentOwnModelKey")}
            value={providerKey}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={credential.data?.key_hint || "••••"}
            onChangeText={setProviderKey}
          />
          <Button
            variant="secondary"
            label={t("save")}
            disabled={!providerKey}
            pending={pending === "provider"}
            onPress={() =>
              void act("provider", async () => {
                await api.updateAgentProviderCredential(agent.id, {
                  api_key: providerKey,
                  clear: false,
                });
                setProviderKey("");
                await credential.refetch();
              })
            }
          />
        </GroupBody>
      ) : null}
      {(keys.data ?? [])
        .filter((key) => !key.revoked_at)
        .map((key) => (
          <View key={key.id}>
            <Divider />
            <ActionRow
              icon={Trash2}
              tone="danger"
              label={t("agentKeyRevoke", {
                name: `${key.name} (${key.prefix}…)`,
              })}
              pending={pending === key.id}
              onPress={() =>
                void act(key.id, () => api.revokeAgentKey(agent.id, key.id))
              }
            />
          </View>
        ))}
      <Divider />
      <ActionRow
        icon={Plus}
        label={t("createRuntimeKey")}
        pending={pending === "runtime"}
        onPress={() =>
          void act("runtime", async () => {
            const created = await api.createAgentKey(agent.id, {
              name: "runtime",
              scopes: agent.allowed_scopes.filter(
                (scope) => scope !== "runtime:worker",
              ),
              rate_limit_per_minute: agent.rate_limit_per_minute,
            });
            setSecret(created.secret);
          })
        }
      />
      <Divider />
      <ActionRow
        icon={Plus}
        label={t("createWorkspaceWorkerKey")}
        hint={t("workspaceWorkerKeyHint")}
        pending={pending === "worker"}
        onPress={() =>
          void act("worker", async () => {
            if (!agent.allowed_scopes.includes("runtime:worker"))
              await api.updateAgent(agent.id, {
                allowed_scopes: [...agent.allowed_scopes, "runtime:worker"],
              });
            const created = await api.createAgentKey(agent.id, {
              name: "workspace-runtime",
              scopes: ["runtime:worker"],
              rate_limit_per_minute: agent.rate_limit_per_minute,
            });
            setSecret(created.secret);
          })
        }
      />
      <GroupBody>
        <Text tone="muted" size={13.5}>
          {t("workspaceWorkerKeyHint")}
        </Text>
        {secret ? (
          <View
            accessibilityLiveRegion="polite"
            style={[styles.secret, { backgroundColor: theme.warningSoft }]}
          >
            <KeyRound size={18} color={theme.foreground} />
            <Text weight="semibold" size={14.5}>
              {t("copySecretNow")}
            </Text>
            <Text size={13} selectable style={styles.code}>
              {secret}
            </Text>
            <Button
              variant="secondary"
              label={t("agentCopySecret")}
              onPress={() => void Clipboard.setStringAsync(secret)}
            />
          </View>
        ) : null}
        {error ? <Notice title={error} /> : null}
      </GroupBody>
    </SettingsGroup>
  );
}

/** Published versions; any older one can become the new draft. */
function VersionHistory() {
  const { t, i18n } = useTranslation();
  const { api } = useSignedIn();
  const builder = useAgentBuilder();
  const { agent, access } = builder;
  const versions = useQuery({
    queryKey: [...agentKeys.versions(agent.id), agent.published_version],
    queryFn: () => api.agentVersions(agent.id),
  });
  if (!versions.data?.length) return null;
  return (
    <SettingsGroup
      title={t("agentVersionHistory")}
      hint={t("agentVersionsLead")}
    >
      {versions.data.map((version, index) => {
        const date = new Date(version.published_at).toLocaleString(
          i18n.language,
          { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" },
        );
        const current = version.version === agent.published_version;
        return (
          <View key={version.id}>
            {index > 0 && <Divider />}
            <View style={styles.version}>
              <View style={styles.grow}>
                <Text size={16} weight="medium">
                  {t("agentVersionShort", { version: version.version })}
                </Text>
                <Text tone="muted" size={13.5}>
                  {current ? `${date} · ${t("agentVersionCurrent")}` : date}
                </Text>
              </View>
              {!current && access.canPublish ? (
                <Button
                  variant="ghost"
                  label={t("agentRollback")}
                  disabled={Boolean(builder.pending)}
                  onPress={() => void builder.rollback(version.id)}
                />
              ) : null}
            </View>
          </View>
        );
      })}
    </SettingsGroup>
  );
}

/** Copy, reset to the role and delete; a confirmation keeps its own error. */
function DangerZone() {
  const { t, i18n } = useTranslation();
  const { api } = useSignedIn();
  const { agent, refetchAgents } = useAgentBuilder();
  const [dialog, setDialog] = useState<"" | "reset" | "delete">("");
  const [pending, setPending] = useState<"" | "duplicate" | "reset" | "delete">(
    "",
  );
  const [error, setError] = useState("");
  const [dialogError, setDialogError] = useState("");

  async function duplicate() {
    setPending("duplicate");
    setError("");
    try {
      const created = await api.duplicateAgent(agent.id, {
        display_name: `${agent.display_name} — ${t("copySuffix")}`,
        handle: `${agent.handle.slice(0, 24)}_${Math.random().toString(36).slice(2, 6)}`,
      });
      await refetchAgents();
      router.replace(`/agents/${encodeURIComponent(created.id)}/edit`);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPending("");
    }
  }

  async function confirm(kind: "reset" | "delete") {
    setPending(kind);
    setDialogError("");
    try {
      if (kind === "delete") {
        await api.deleteAgent(agent.id);
        setDialog("");
        await refetchAgents();
        router.dismissAll();
        return;
      }
      await api.resetAgentRecipe(
        agent.id,
        i18n.resolvedLanguage ?? i18n.language,
      );
      setDialog("");
      await refetchAgents();
    } catch (cause) {
      setDialogError(messageOf(cause));
    } finally {
      setPending("");
    }
  }

  return (
    <SettingsGroup title={t("agentManageTitle")}>
      <ActionRow
        icon={Copy}
        tone="default"
        label={t("duplicateAgent")}
        pending={pending === "duplicate"}
        onPress={() => void duplicate()}
      />
      {agent.recipe !== "custom" ? (
        <>
          <Divider />
          <ActionRow
            icon={RotateCcw}
            tone="default"
            label={t("resetTemplate")}
            onPress={() => {
              setDialogError("");
              setDialog("reset");
            }}
          />
        </>
      ) : null}
      <Divider />
      <ActionRow
        testID="agent-delete"
        icon={Trash2}
        tone="danger"
        label={t("deleteAgent")}
        onPress={() => {
          setDialogError("");
          setDialog("delete");
        }}
      />
      {error ? (
        <GroupBody>
          <Notice title={error} />
        </GroupBody>
      ) : null}
      <BottomSheet
        visible={dialog !== ""}
        title={t(
          dialog === "delete" ? "deleteAgentTitle" : "resetTemplateTitle",
        )}
        onClose={() => setDialog("")}
      >
        <View style={styles.dialog}>
          <Text tone="muted" size={15}>
            {t(
              dialog === "delete"
                ? "deleteAgentDescription"
                : "resetTemplateDescription",
              { name: agent.display_name },
            )}
          </Text>
          {dialogError ? <Notice title={dialogError} /> : null}
          <Button
            testID="agent-dialog-confirm"
            label={t(
              dialog === "delete"
                ? "deleteAgentConfirm"
                : "resetTemplateConfirm",
            )}
            pending={pending === dialog}
            onPress={() => {
              if (dialog) void confirm(dialog);
            }}
          />
          <Button
            variant="ghost"
            label={t("cancel")}
            disabled={Boolean(pending)}
            onPress={() => setDialog("")}
          />
        </View>
      </BottomSheet>
    </SettingsGroup>
  );
}

const styles = StyleSheet.create({
  scope: { paddingHorizontal: spacing[4], paddingVertical: spacing[2], gap: 2 },
  code: { fontFamily: "Menlo" },
  secret: { borderRadius: radius.md, padding: spacing[3], gap: spacing[2] },
  version: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[2],
    paddingLeft: spacing[4],
    paddingRight: spacing[2],
    paddingVertical: spacing[2],
    minHeight: 56,
  },
  dialog: { padding: spacing[4], gap: spacing[3] },
  grow: { flex: 1 },
});
