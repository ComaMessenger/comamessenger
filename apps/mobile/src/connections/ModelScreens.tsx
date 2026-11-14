import { useState } from "react";
import { Alert, View } from "react-native";
import { router } from "expo-router";
import { Plus, Sparkles } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  createLlmConnectionRequest,
  emptyLlmConnectionDraft,
  llmConnectionDraftReady,
  llmConnectionEdit,
  llmConnectionEditReady,
  llmEndpointProblem,
  llmProviders,
  providerNeedsEndpoint,
  providerSupportsEmbeddings,
  updateLlmConnectionRequest,
  withProvider,
  type AgentLlmConnection,
  type LlmConnectionDraft,
  type LlmConnectionEdit,
  type LlmProvider,
} from "@comamessenger/core";
import { useSignedIn } from "@/session/SessionProvider";
import { SettingsScreen } from "@/settings/SettingsScreen";
import { Button } from "@/ui/Button";
import { IconButton } from "@/ui/IconButton";
import { Notice } from "@/ui/Notice";
import { PickerSheet } from "@/ui/PickerSheet";
import {
  ActionRow,
  Divider,
  GroupBody,
  InfoRow,
  NavRow,
  SettingsGroup,
  SwitchRow,
} from "@/ui/Settings";
import { TextField } from "@/ui/TextField";
import {
  dateTime,
  errorText,
  healthErrorText,
  healthText,
  modelsKey,
  useConnectionsAccess,
  useModelUsage,
  useModels,
  useStore,
} from "./data";
import { SecretField } from "./SecretField";

const plain = {
  autoCapitalize: "none",
  autoCorrect: false,
  spellCheck: false,
} as const;

function providerLabel(provider: string, t: (key: string) => string) {
  return t(`connProvider_${provider}`);
}

/** «Настройки → Модели»: the workspace's model connections. */
export function ModelsScreen() {
  const { t } = useTranslation();
  const access = useConnectionsAccess();
  const models = useModels();
  const list = models.data ?? [];
  return (
    <SettingsScreen
      title={t("connModels")}
      testID="connections-models"
      allowed={access.viewModels}
      query={models}
      trailing={
        access.manage ? (
          <IconButton
            testID="model-add"
            label={t("connModelAdd")}
            onPress={() => router.push("/settings/connections/models/new")}
            icon={(color) => <Plus size={22} color={color} />}
          />
        ) : undefined
      }
    >
      <SettingsGroup
        hint={access.manage ? t("connModelsLead") : t("connReadOnly")}
      >
        {list.length === 0 ? (
          <GroupBody>
            <Notice
              tone="neutral"
              title={t("connModelsEmpty")}
              hint={
                access.manage
                  ? t("connModelsEmptyHint")
                  : t("connModelsEmptyReadOnly")
              }
            />
          </GroupBody>
        ) : (
          list.map((item, index) => (
            <View key={item.id}>
              {index > 0 && <Divider />}
              <NavRow
                testID={`model-${item.name}`}
                icon={Sparkles}
                label={item.name}
                hint={`${providerLabel(item.provider, t)} · ${
                  item.default_model || t("connModelUnset")
                }`}
                value={healthText(item)}
                onPress={() =>
                  router.push(`/settings/connections/models/${item.id}`)
                }
              />
            </View>
          ))
        )}
        {access.manage && (
          <>
            <Divider />
            <ActionRow
              testID="model-add-row"
              icon={Plus}
              label={t("connModelAdd")}
              onPress={() => router.push("/settings/connections/models/new")}
            />
          </>
        )}
      </SettingsGroup>
    </SettingsScreen>
  );
}

/** Provider, address, model and key fields shared by «new» and «edit». */
function ConnectionFields({
  value,
  onChange,
  editing,
}: {
  value: LlmConnectionDraft | LlmConnectionEdit;
  onChange(change: Partial<LlmConnectionEdit>): void;
  editing: boolean;
}) {
  const { t } = useTranslation();
  const [picker, setPicker] = useState(false);
  const problem = llmEndpointProblem(value.endpoint_url);
  return (
    <>
      <GroupBody>
        <TextField
          testID="model-name"
          label={t("connModelName")}
          placeholder={t("connModelNamePlaceholder")}
          value={value.name}
          maxLength={120}
          onChangeText={(name) => onChange({ name })}
        />
      </GroupBody>
      <Divider />
      <NavRow
        testID="model-provider"
        label={t("connProvider")}
        value={providerLabel(value.provider, t)}
        onPress={() => setPicker(true)}
      />
      <Divider />
      <GroupBody>
        {providerNeedsEndpoint(value.provider) && (
          <TextField
            testID="model-endpoint"
            label={t("connEndpoint")}
            placeholder="https://api.example.com/v1"
            keyboardType="url"
            value={value.endpoint_url}
            maxLength={2048}
            onChangeText={(endpoint_url) => onChange({ endpoint_url })}
            error={
              value.endpoint_url.trim() && problem
                ? t(`connEndpointProblem_${problem}`)
                : undefined
            }
            hint={t("connEndpointHint")}
            {...plain}
          />
        )}
        <TextField
          testID="model-default"
          label={t("connDefaultModel")}
          hint={t("connDefaultModelHint")}
          placeholder="gpt-4o-mini"
          value={value.default_model}
          maxLength={200}
          onChangeText={(default_model) => onChange({ default_model })}
          {...plain}
        />
        <SecretField
          testID="model-key"
          label={editing ? t("connApiKeyNew") : t("connApiKey")}
          placeholder={editing ? t("connApiKeyKeep") : "sk-…"}
          hint={t("connApiKeyHint")}
          value={value.api_key}
          onChange={(api_key) => onChange({ api_key })}
        />
      </GroupBody>
      <PickerSheet<LlmProvider>
        visible={picker}
        testID="model-provider-picker"
        title={t("connProvider")}
        value={value.provider}
        options={llmProviders.map((provider) => ({
          value: provider,
          label: providerLabel(provider, t),
        }))}
        onSelect={(provider) =>
          onChange(
            withProvider({ ...value }, provider) as Partial<LlmConnectionEdit>,
          )
        }
        onClose={() => setPicker(false)}
      />
    </>
  );
}

/** «Новое подключение»: the web's form; the connection is tested right after. */
export function ModelCreateScreen() {
  const { t } = useTranslation();
  const { api } = useSignedIn();
  const access = useConnectionsAccess();
  const store = useStore();
  const [draft, setDraft] = useState<LlmConnectionDraft>(
    emptyLlmConnectionDraft,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const endpointOK =
    !providerNeedsEndpoint(draft.provider) ||
    llmEndpointProblem(draft.endpoint_url) === null;

  async function save() {
    setPending(true);
    setError("");
    try {
      const created = await api.createAgentLlmConnection(
        createLlmConnectionRequest(draft),
      );
      // The key leaves the phone's memory as soon as the server has it.
      setDraft(emptyLlmConnectionDraft);
      store.model(created);
      try {
        store.model(await api.testAgentLlmConnection(created.id));
      } catch {
        /* The status screen offers the test again. */
      }
      router.replace(`/settings/connections/models/${created.id}`);
    } catch (cause) {
      setError(errorText(cause, "model"));
    } finally {
      setPending(false);
    }
  }

  return (
    <SettingsScreen
      title={t("connModelNew")}
      testID="connections-model-new"
      allowed={access.manage}
    >
      <SettingsGroup hint={t("connModelSecurity")}>
        <ConnectionFields
          editing={false}
          value={draft}
          onChange={(change) =>
            setDraft(
              (current) => ({ ...current, ...change }) as LlmConnectionDraft,
            )
          }
        />
      </SettingsGroup>
      {error ? <Notice title={error} /> : null}
      <Button
        testID="model-save"
        label={t("save")}
        pending={pending}
        disabled={!llmConnectionDraftReady(draft) || !endpointOK}
        onPress={() => void save()}
      />
    </SettingsScreen>
  );
}

/** One model connection: status and test, use, switch, edit, delete. */
export function ModelScreen({ id }: { id: string }) {
  const { t } = useTranslation();
  const access = useConnectionsAccess();
  const models = useModels();
  const connection = models.data?.find((item) => item.id === id);
  return (
    <SettingsScreen
      title={connection?.name ?? t("connModels")}
      subtitle={connection ? providerLabel(connection.provider, t) : undefined}
      testID="connections-model"
      allowed={access.viewModels}
      query={models}
    >
      {connection ? (
        <ModelDetails connection={connection} manage={access.manage} />
      ) : (
        <Notice tone="neutral" title={t("connNotFound")} />
      )}
    </SettingsScreen>
  );
}

function ModelDetails({
  connection,
  manage,
}: {
  connection: AgentLlmConnection;
  manage: boolean;
}) {
  const { t } = useTranslation();
  const { api } = useSignedIn();
  const store = useStore();
  const usage = useModelUsage(connection.id);
  const [busy, setBusy] = useState<
    "test" | "enable" | "save" | "delete" | null
  >(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const [edit, setEdit] = useState(() => llmConnectionEdit(connection));
  const change = updateLlmConnectionRequest(connection, edit);
  const usageParts = [
    ...usage.agents.map((agent) => agent.display_name),
    ...(usage.collections.length
      ? [t("connUsageCollections", { count: usage.collections.length })]
      : []),
  ];

  async function act<T>(
    kind: NonNullable<typeof busy>,
    action: () => Promise<T>,
  ): Promise<T | null> {
    setBusy(kind);
    setResult(null);
    try {
      return await action();
    } catch (cause) {
      setResult({ ok: false, text: errorText(cause, "model") });
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    const tested = await act("test", () =>
      api.testAgentLlmConnection(connection.id),
    );
    if (!tested) return;
    store.model(tested);
    setResult(
      tested.health_status === "healthy"
        ? { ok: true, text: t("connTestOk") }
        : {
            ok: false,
            text: `${t("connTestFailed")}. ${healthErrorText(tested.last_error_code)}`,
          },
    );
  }

  async function setEnabled(enabled: boolean) {
    const updated = await act("enable", () =>
      api.updateAgentLlmConnection(connection.id, { enabled }),
    );
    if (updated) store.model(updated);
  }

  async function save() {
    if (!change) return;
    const updated = await act("save", () =>
      api.updateAgentLlmConnection(connection.id, change),
    );
    if (!updated) return;
    store.model(updated);
    // A new key is gone from the form as soon as the server has it.
    setEdit(llmConnectionEdit(updated));
    setResult({ ok: true, text: t("connSaved") });
  }

  function remove() {
    if (usageParts.length) {
      Alert.alert(
        t("connDeleteBlockedTitle"),
        t("connDeleteBlockedText", { usage: usageParts.join(", ") }),
        [
          { text: t("cancel"), style: "cancel" },
          ...(connection.enabled
            ? [
                {
                  text: t("connDisableInstead"),
                  onPress: () => void setEnabled(false),
                },
              ]
            : []),
        ],
      );
      return;
    }
    Alert.alert(
      t("connDeleteTitle", { name: connection.name }),
      t("connDeleteText"),
      [
        { text: t("cancel"), style: "cancel" },
        {
          text: t("delete"),
          style: "destructive",
          onPress: async () => {
            const done = await act("delete", async () => {
              await api.deleteAgentLlmConnection(connection.id);
              return true;
            });
            if (!done) return;
            store.remove(modelsKey, connection.id);
            router.back();
          },
        },
      ],
    );
  }

  const status = healthText(connection);
  const statusHint = connection.last_tested_at
    ? t("connTestedAt", { time: dateTime(connection.last_tested_at) })
    : t("connNeverTested");
  const failure = healthErrorText(connection.last_error_code);

  return (
    <>
      <SettingsGroup title={t("connStatus")}>
        <InfoRow testID="model-status" label={status} value={statusHint} />
        {connection.health_status === "unhealthy" && failure ? (
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
              testID="model-test"
              label={t("connTest")}
              pending={busy === "test"}
              disabled={busy !== null}
              onPress={() => void test()}
            />
            <Divider />
            <SwitchRow
              testID="model-enabled"
              label={t("connEnabled")}
              hint={t("connEnabledHint")}
              value={connection.enabled}
              disabled={busy !== null}
              onChange={(value) => void setEnabled(value)}
            />
          </>
        )}
      </SettingsGroup>
      {result && (
        <Notice tone={result.ok ? "success" : "danger"} title={result.text} />
      )}

      <SettingsGroup>
        <InfoRow
          label={t("connProvider")}
          value={providerLabel(connection.provider, t)}
        />
        {connection.endpoint_url ? (
          <>
            <Divider />
            <InfoRow
              label={t("connEndpoint")}
              value={connection.endpoint_url}
            />
          </>
        ) : null}
        <Divider />
        <InfoRow
          label={t("connDefaultModel")}
          value={connection.default_model || t("connModelUnset")}
        />
        <Divider />
        <InfoRow
          testID="model-key-hint"
          label={t("connKey")}
          value={connection.key_hint}
        />
        {connection.embedding_model ? (
          <>
            <Divider />
            <InfoRow
              label={t("connEmbeddingModel")}
              value={connection.embedding_model}
            />
          </>
        ) : null}
        <Divider />
        <InfoRow
          testID="model-usage"
          label={t("connUsage")}
          value={
            usageParts.length
              ? usageParts.join(", ")
              : usage.known
                ? t("connUsageNone")
                : "—"
          }
        />
      </SettingsGroup>

      {manage ? (
        <>
          <SettingsGroup title={t("connEdit")}>
            <ConnectionFields
              editing
              value={edit}
              onChange={(next) =>
                setEdit((current) => ({ ...current, ...next }))
              }
            />
            {providerSupportsEmbeddings(edit.provider) && (
              <>
                <Divider />
                <GroupBody>
                  <TextField
                    testID="model-embedding"
                    label={t("connEmbeddingModel")}
                    hint={t("connEmbeddingModelHint")}
                    placeholder="text-embedding-3-small"
                    value={edit.embedding_model}
                    maxLength={200}
                    onChangeText={(embedding_model) =>
                      setEdit((current) => ({ ...current, embedding_model }))
                    }
                    {...plain}
                  />
                </GroupBody>
                {edit.embedding_model.trim() ? (
                  <>
                    <Divider />
                    <SwitchRow
                      testID="model-embedding-consent"
                      label={t("connEmbeddingConsent")}
                      hint={t("connEmbeddingConsentHint")}
                      value={edit.embedding_data_sharing_approved}
                      onChange={(embedding_data_sharing_approved) =>
                        setEdit((current) => ({
                          ...current,
                          embedding_data_sharing_approved,
                        }))
                      }
                    />
                  </>
                ) : null}
              </>
            )}
          </SettingsGroup>
          <Button
            testID="model-update"
            label={t("connSave")}
            pending={busy === "save"}
            disabled={!change || !llmConnectionEditReady(edit) || busy !== null}
            onPress={() => void save()}
          />
          <SettingsGroup>
            <ActionRow
              testID="model-delete"
              tone="danger"
              label={t("connDelete")}
              pending={busy === "delete"}
              disabled={busy !== null}
              onPress={remove}
            />
          </SettingsGroup>
        </>
      ) : (
        <Notice tone="neutral" title={t("connReadOnly")} />
      )}
    </>
  );
}
