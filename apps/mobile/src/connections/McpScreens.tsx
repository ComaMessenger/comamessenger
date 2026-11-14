import { useState } from "react";
import { Alert, ScrollView, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  createMcpConnectionRequest,
  emptyMcpConnectionDraft,
  isMcpToolAssignable,
  mcpConnectionDraftReady,
  mcpConnectionEdit,
  mcpConnectionEditReady,
  mcpEditDropsSecret,
  mcpEndpointProblem,
  mcpNamePattern,
  toggledAssignableTools,
  updateMcpConnectionRequest,
  type McpConnection,
  type McpConnectionDraft,
  type McpConnectionEdit,
} from "@comamessenger/core";
import { spacing } from "@comamessenger/tokens";
import { useSignedIn } from "@/session/SessionProvider";
import { SettingsScreen, settingsContent } from "@/settings/SettingsScreen";
import { Button } from "@/ui/Button";
import { Notice } from "@/ui/Notice";
import { PageSheet } from "@/ui/PageSheet";
import {
  ActionRow,
  Divider,
  GroupBody,
  InfoRow,
  SettingsGroup,
  SwitchRow,
} from "@/ui/Settings";
import { Text } from "@/ui/Text";
import { TextField } from "@/ui/TextField";
import {
  dateTime,
  errorText,
  healthErrorText,
  healthText,
  mcpKey,
  useConnectionsAccess,
  useMcpConnections,
  useStore,
} from "./data";
import { SecretField } from "./SecretField";

const plain = {
  autoCapitalize: "none",
  autoCorrect: false,
  spellCheck: false,
} as const;

/** Address field with the server's outbound rules as a hint. */
function EndpointField({
  value,
  allowPrivate,
  onChange,
}: {
  value: string;
  allowPrivate: boolean;
  onChange(value: string): void;
}) {
  const { t } = useTranslation();
  const problem = value.trim() ? mcpEndpointProblem(value, allowPrivate) : null;
  return (
    <TextField
      testID="mcp-endpoint"
      label={t("connMcpEndpoint")}
      placeholder="https://mcp.example.com/mcp"
      keyboardType="url"
      maxLength={2048}
      value={value}
      onChangeText={onChange}
      // «internal» is advice: the operator's list decides on the server.
      error={
        problem && problem !== "internal"
          ? t(`connEndpointProblem_${problem}`)
          : undefined
      }
      hint={
        problem === "internal" ? t("connEndpointProblem_internal") : undefined
      }
      {...plain}
    />
  );
}

/** «Новая внешняя система»: the web's form; tested right after to list tools. */
export function McpCreateScreen() {
  const { t } = useTranslation();
  const { api } = useSignedIn();
  const access = useConnectionsAccess();
  const store = useStore();
  const [draft, setDraft] = useState<McpConnectionDraft>(
    emptyMcpConnectionDraft,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const set = (change: Partial<McpConnectionDraft>) =>
    setDraft((current) => ({ ...current, ...change }));
  const nameInvalid =
    Boolean(draft.name) && !mcpNamePattern.test(draft.name.trim());
  const problem = mcpEndpointProblem(
    draft.endpoint_url,
    draft.allow_private_network,
  );

  async function save() {
    setPending(true);
    setError("");
    try {
      const created = await api.createMcpConnection(
        createMcpConnectionRequest(draft),
      );
      setDraft(emptyMcpConnectionDraft);
      store.mcp(created);
      try {
        store.mcp(await api.testMcpConnection(created.id));
      } catch {
        /* The connection screen offers the test again. */
      }
      router.replace(`/settings/connections/integrations/mcp/${created.id}`);
    } catch (cause) {
      setError(errorText(cause, "mcp"));
    } finally {
      setPending(false);
    }
  }

  return (
    <SettingsScreen
      title={t("connMcpNew")}
      testID="connections-mcp-new"
      allowed={access.manage}
    >
      <SettingsGroup hint={t("connMcpSecurity")}>
        <GroupBody>
          <TextField
            testID="mcp-name"
            label={t("connMcpName")}
            placeholder="accounting"
            maxLength={40}
            value={draft.name}
            onChangeText={(name) => set({ name: name.toLowerCase() })}
            error={nameInvalid ? t("connMcpNameInvalid") : undefined}
            hint={t("connMcpNameHint")}
            {...plain}
          />
          <TextField
            testID="mcp-description"
            label={t("connMcpDescription")}
            maxLength={500}
            value={draft.description}
            onChangeText={(description) => set({ description })}
          />
          <EndpointField
            value={draft.endpoint_url}
            allowPrivate={draft.allow_private_network}
            onChange={(endpoint_url) => set({ endpoint_url })}
          />
          <TextField
            testID="mcp-header-name"
            label={t("connMcpHeaderName")}
            value={draft.header_name}
            onChangeText={(header_name) => set({ header_name })}
            {...plain}
          />
          <SecretField
            testID="mcp-header-value"
            label={t("connMcpHeaderValue")}
            placeholder="Bearer …"
            hint={t("connMcpHeaderValueHint")}
            value={draft.header_value}
            onChange={(header_value) => set({ header_value })}
          />
        </GroupBody>
      </SettingsGroup>
      <SettingsGroup>
        <SwitchRow
          testID="mcp-private"
          label={t("connMcpPrivate")}
          hint={t("connMcpPrivateHint")}
          value={draft.allow_private_network}
          onChange={(allow_private_network) => set({ allow_private_network })}
        />
        <Divider />
        <SwitchRow
          testID="mcp-agent-use"
          label={t("connMcpAgentUse")}
          hint={t("connMcpAgentUseHint")}
          value={draft.agent_use_allowed}
          onChange={(agent_use_allowed) => set({ agent_use_allowed })}
        />
        <Divider />
        <SwitchRow
          testID="mcp-writes"
          label={t("connMcpWrites")}
          hint={t("connMcpWritesHint")}
          value={draft.writes_require_confirmation}
          onChange={(writes_require_confirmation) =>
            set({ writes_require_confirmation })
          }
        />
      </SettingsGroup>
      {error ? <Notice title={error} /> : null}
      <Button
        testID="mcp-save"
        label={t("save")}
        pending={pending}
        disabled={
          !mcpConnectionDraftReady(draft) ||
          (problem !== null && problem !== "internal")
        }
        onPress={() => void save()}
      />
    </SettingsScreen>
  );
}

/** One MCP connection: status, rules, tools one by one, edit, detach, delete. */
export function McpScreen({ id }: { id: string }) {
  const { t } = useTranslation();
  const access = useConnectionsAccess();
  const mcp = useMcpConnections();
  const connection = mcp.data?.find((item) => item.id === id);
  return (
    <SettingsScreen
      title={connection?.name ?? t("connMcpTitle")}
      subtitle={connection?.description || undefined}
      testID="connections-mcp"
      allowed={access.viewIntegrations}
      query={mcp}
    >
      {connection ? (
        <McpDetails connection={connection} manage={access.manage} />
      ) : (
        <Notice tone="neutral" title={t("connNotFound")} />
      )}
    </SettingsScreen>
  );
}

type Busy = "test" | "rule" | "tool" | "save" | "delete" | null;

function McpDetails({
  connection,
  manage,
}: {
  connection: McpConnection;
  manage: boolean;
}) {
  const { t } = useTranslation();
  const { api } = useSignedIn();
  const store = useStore();
  const [busy, setBusy] = useState<Busy>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const [edit, setEdit] = useState(() => mcpConnectionEdit(connection));
  const [detaching, setDetaching] = useState(false);
  const change = updateMcpConnectionRequest(connection, edit);
  const dropsSecret = mcpEditDropsSecret(connection, edit);

  async function act(
    kind: NonNullable<Busy>,
    action: () => Promise<McpConnection>,
  ) {
    setBusy(kind);
    setResult(null);
    try {
      const updated = await action();
      store.mcp(updated);
      return updated;
    } catch (cause) {
      setResult({ ok: false, text: errorText(cause, "mcp") });
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    const tested = await act("test", () =>
      api.testMcpConnection(connection.id),
    );
    if (!tested) return;
    setResult(
      tested.health_status === "healthy"
        ? { ok: true, text: t("connTestOk") }
        : {
            ok: false,
            text: `${t("connTestFailed")}. ${healthErrorText(tested.last_error_code)}`,
          },
    );
  }

  const rule = (input: Parameters<typeof api.updateMcpConnection>[1]) =>
    void act("rule", () => api.updateMcpConnection(connection.id, input));

  async function save() {
    if (!change) return;
    const updated = await act("save", () =>
      api.updateMcpConnection(connection.id, change),
    );
    if (!updated) return;
    setEdit(mcpConnectionEdit(updated));
    setResult({ ok: true, text: t("connSaved") });
  }

  function remove() {
    if (connection.agent_count > 0) {
      Alert.alert(t("connMcpDeleteBlocked"), undefined, [
        { text: t("cancel"), style: "cancel" },
        { text: t("connMcpDetach"), onPress: () => setDetaching(true) },
      ]);
      return;
    }
    Alert.alert(
      t("connDeleteTitle", { name: connection.name }),
      t("connMcpDeleteText"),
      [
        { text: t("cancel"), style: "cancel" },
        {
          text: t("delete"),
          style: "destructive",
          onPress: async () => {
            setBusy("delete");
            try {
              await api.deleteMcpConnection(connection.id);
              store.remove(mcpKey, connection.id);
              router.back();
            } catch (cause) {
              setResult({ ok: false, text: errorText(cause, "mcp") });
            } finally {
              setBusy(null);
            }
          },
        },
      ],
    );
  }

  const failure = healthErrorText(connection.last_error_code);
  const tested = connection.last_tested_at
    ? t("connTestedAt", { time: dateTime(connection.last_tested_at) })
    : t("connNeverTested");
  const set = (next: Partial<McpConnectionEdit>) =>
    setEdit((current) => ({ ...current, ...next }));

  return (
    <>
      <SettingsGroup title={t("connStatus")}>
        <InfoRow
          testID="mcp-status"
          label={healthText(connection)}
          value={tested}
        />
        {failure ? (
          <GroupBody>
            <Notice
              title={failure}
              hint={t("connErrorCode", { code: connection.last_error_code })}
            />
          </GroupBody>
        ) : null}
        {manage && (
          <>
            <Divider />
            <ActionRow
              testID="mcp-test"
              label={t("connTest")}
              pending={busy === "test"}
              disabled={busy !== null}
              onPress={() => void test()}
            />
            <Divider />
            <SwitchRow
              testID="mcp-enabled"
              label={t("connEnabled")}
              value={connection.enabled}
              disabled={busy !== null}
              onChange={(enabled) => rule({ enabled })}
            />
            <Divider />
            <SwitchRow
              testID="mcp-agent-use"
              label={t("connMcpAgentUse")}
              hint={t("connMcpAgentUseHint")}
              value={connection.agent_use_allowed}
              disabled={busy !== null}
              onChange={(agent_use_allowed) => rule({ agent_use_allowed })}
            />
            <Divider />
            <SwitchRow
              testID="mcp-writes"
              label={t("connMcpWrites")}
              hint={t("connMcpWritesHint")}
              value={connection.writes_require_confirmation}
              disabled={busy !== null}
              onChange={(writes_require_confirmation) =>
                rule({ writes_require_confirmation })
              }
            />
          </>
        )}
      </SettingsGroup>
      {result && (
        <Notice tone={result.ok ? "success" : "danger"} title={result.text} />
      )}

      <SettingsGroup>
        <InfoRow
          label={t("connMcpEndpoint")}
          value={
            connection.allow_private_network
              ? `${connection.endpoint_url} · ${t("connMcpPrivate")}`
              : connection.endpoint_url
          }
        />
        <Divider />
        <InfoRow
          testID="mcp-secret-hint"
          label={t("connKey")}
          value={connection.secret_hint || t("connMcpNoSecret")}
        />
        <Divider />
        <InfoRow
          label={t("connUsage")}
          value={
            connection.agent_count
              ? t("connUsageAgents", { count: connection.agent_count })
              : t("connUsageNone")
          }
        />
      </SettingsGroup>

      <SettingsGroup
        title={t("connMcpTools")}
        hint={connection.tools.length ? t("connMcpToolsHint") : undefined}
      >
        {connection.tools.length === 0 ? (
          <GroupBody>
            <Text tone="muted" size={14}>
              {t("connMcpToolsUnknown")}
            </Text>
          </GroupBody>
        ) : (
          connection.tools.map((tool, index) => {
            const kind = tool.read_only
              ? t("connMcpToolRead")
              : t("connMcpToolWrite");
            const hint = [kind, tool.description].filter(Boolean).join(" · ");
            return (
              <View key={tool.name}>
                {index > 0 && <Divider />}
                {manage ? (
                  <SwitchRow
                    testID={`mcp-tool-${tool.name}`}
                    label={tool.name}
                    hint={hint}
                    value={isMcpToolAssignable(connection, tool.name)}
                    disabled={busy !== null}
                    onChange={(value) =>
                      void act("tool", () =>
                        api.updateMcpConnection(connection.id, {
                          assignable_tools: toggledAssignableTools(
                            connection,
                            tool.name,
                            value,
                          ),
                        }),
                      )
                    }
                  />
                ) : (
                  <InfoRow label={tool.name} value={kind} />
                )}
              </View>
            );
          })
        )}
      </SettingsGroup>

      {manage && (
        <>
          <SettingsGroup title={t("connEdit")} hint={t("connMcpSecurity")}>
            <GroupBody>
              <TextField
                testID="mcp-description"
                label={t("connMcpDescription")}
                maxLength={500}
                value={edit.description}
                onChangeText={(description) => set({ description })}
              />
              <EndpointField
                value={edit.endpoint_url}
                allowPrivate={edit.allow_private_network}
                onChange={(endpoint_url) => set({ endpoint_url })}
              />
            </GroupBody>
            <Divider />
            <SwitchRow
              label={t("connMcpPrivate")}
              hint={t("connMcpPrivateHint")}
              value={edit.allow_private_network}
              onChange={(allow_private_network) =>
                set({ allow_private_network })
              }
            />
            <Divider />
            <SwitchRow
              testID="mcp-replace-headers"
              label={t("connMcpReplaceHeaders")}
              hint={t("connMcpReplaceHeadersHint")}
              value={edit.replace_headers}
              onChange={(replace_headers) =>
                set({ replace_headers, header_value: "" })
              }
            />
            {edit.replace_headers && (
              <GroupBody>
                <TextField
                  label={t("connMcpHeaderName")}
                  value={edit.header_name}
                  onChangeText={(header_name) => set({ header_name })}
                  {...plain}
                />
                <SecretField
                  testID="mcp-edit-header-value"
                  label={t("connMcpHeaderValue")}
                  placeholder="Bearer …"
                  value={edit.header_value}
                  onChange={(header_value) => set({ header_value })}
                />
              </GroupBody>
            )}
            <Divider />
            <GroupBody>
              <TextField
                label={t("connMcpTimeout")}
                keyboardType="number-pad"
                value={String(edit.timeout_ms || "")}
                onChangeText={(text) =>
                  set({ timeout_ms: Number(text.replace(/\D/g, "")) || 0 })
                }
              />
              <TextField
                label={t("connMcpMaxOutput")}
                keyboardType="number-pad"
                hint={t("connMcpLimitsHint")}
                value={String(Math.round(edit.max_output_bytes / 1024) || "")}
                onChangeText={(text) =>
                  set({
                    max_output_bytes:
                      (Number(text.replace(/\D/g, "")) || 0) * 1024,
                  })
                }
              />
            </GroupBody>
          </SettingsGroup>
          {dropsSecret && <Notice title={t("connMcpDropsSecret")} />}
          <Button
            testID="mcp-update"
            label={t("connSave")}
            pending={busy === "save"}
            disabled={!change || !mcpConnectionEditReady(edit) || busy !== null}
            onPress={() => void save()}
          />
          <SettingsGroup>
            {connection.agent_count > 0 && (
              <>
                <ActionRow
                  testID="mcp-detach"
                  label={t("connMcpDetach")}
                  disabled={busy !== null}
                  onPress={() => setDetaching(true)}
                />
                <Divider />
              </>
            )}
            <ActionRow
              testID="mcp-delete"
              tone="danger"
              label={t("connMcpDelete")}
              pending={busy === "delete"}
              disabled={busy !== null}
              onPress={remove}
            />
          </SettingsGroup>
        </>
      )}
      {detaching && (
        <DetachSheet
          connection={connection}
          onClose={() => setDetaching(false)}
        />
      )}
    </>
  );
}

/** Which agents use the connection, then detach exactly those. */
function DetachSheet({
  connection,
  onClose,
}: {
  connection: McpConnection;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const { api } = useSignedIn();
  const store = useStore();
  const usage = useQuery({
    queryKey: ["mcp-connection-usage", connection.id],
    queryFn: () => api.mcpConnectionUsage(connection.id),
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const affected = usage.data ?? [];

  async function detach() {
    setPending(true);
    setError("");
    try {
      await api.detachMcpConnection(
        connection.id,
        affected.map((item) => item.agent_id),
      );
      store.mcp({ ...connection, agent_count: 0 });
      onClose();
    } catch (cause) {
      setError(errorText(cause, "mcp"));
      await usage.refetch();
    } finally {
      setPending(false);
    }
  }

  return (
    <PageSheet
      visible
      testID="mcp-detach-sheet"
      title={t("connMcpDetachTitle", { name: connection.name })}
      onClose={onClose}
    >
      <ScrollView contentContainerStyle={settingsContent}>
        <Text tone="muted" size={14}>
          {t("connMcpDetachText")}
        </Text>
        {usage.isError && usage.data === undefined ? (
          <Notice
            title={errorText(usage.error, "mcp")}
            actionLabel={t("retry")}
            onAction={() => void usage.refetch()}
          />
        ) : usage.isPending ? null : affected.length === 0 ? (
          <Notice tone="neutral" title={t("connMcpDetachEmpty")} />
        ) : (
          <SettingsGroup>
            {affected.map((item, index) => (
              <View key={item.agent_id}>
                {index > 0 && <Divider />}
                <View style={styles.usage}>
                  <Text weight="medium">{item.display_name}</Text>
                  <Text tone="muted" size={13.5}>
                    {[
                      item.published && t("connMcpDetachPublished"),
                      item.draft && t("connMcpDetachDraft"),
                      item.allowed_tools.join(", "),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </Text>
                </View>
              </View>
            ))}
          </SettingsGroup>
        )}
        {error ? <Notice title={error} /> : null}
        <Button
          testID="mcp-detach-confirm"
          label={t("connMcpDetachConfirm", { count: affected.length })}
          pending={pending}
          disabled={usage.isPending || affected.length === 0}
          onPress={() => void detach()}
        />
      </ScrollView>
    </PageSheet>
  );
}

const styles = StyleSheet.create({
  usage: {
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    gap: spacing[1],
  },
});
