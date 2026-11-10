import type { Agent, MessengerAPI } from "@comamessenger/core";
import { KeyRound, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button, Field } from "../../ui";
import { SettingsSection } from "../../settings/components/SettingsPrimitives";
import type { AgentOperationsState } from "./useAgentOperations";

export function AgentCredentialsSection({
  api,
  agent,
  operations,
}: {
  api: MessengerAPI;
  agent: Agent;
  operations: AgentOperationsState;
}) {
  const { t } = useTranslation();
  const {
    keys,
    credential,
    providerKey,
    setProviderKey,
    secret,
    setSecret,
    action,
  } = operations;
  return (
    <SettingsSection
      title={t("agentCredentials")}
      description={t("agentCredentialsHint")}
      icon={<KeyRound />}
      wide
    >
      {agent.llm_connection_id ? (
        <div className="agent-wizard__notice">
          <ShieldCheck />
          <span>{t("agentUsesWorkspaceConnection")}</span>
        </div>
      ) : (
        <div className="agent-inline-form">
          <Field
            required={false}
            type="password"
            label={t("providerKey")}
            name="provider-key"
            value={providerKey}
            placeholder={credential.data?.key_hint || "••••"}
            onChange={(e) => setProviderKey(e.target.value)}
          />
          <Button
            disabled={!providerKey}
            onClick={() =>
              void action(async () => {
                await api.updateAgentProviderCredential(agent.id, {
                  api_key: providerKey,
                  clear: false,
                });
                setProviderKey("");
              })
            }
          >
            {t("save")}
          </Button>
        </div>
      )}
      <div className="agent-record-list">
        {(keys.data ?? []).map((key) => (
          <div key={key.id}>
            <KeyRound />
            <span>
              <strong>{key.name}</strong>
              <small>
                {key.prefix} ·{" "}
                {key.scopes
                  .map((scope) => t(`agentScope_${scope.replace(":", "_")}`))
                  .join(", ")}
              </small>
            </span>
            <Button
              size="icon"
              variant="ghost"
              aria-label={t("delete")}
              onClick={() =>
                void action(() => api.revokeAgentKey(agent.id, key.id))
              }
            >
              <Trash2 />
            </Button>
          </div>
        ))}
      </div>
      <Button
        onClick={() =>
          void action(async () => {
            const created = await api.createAgentKey(agent.id, {
              name: "runtime",
              scopes: agent.allowed_scopes,
              rate_limit_per_minute: agent.rate_limit_per_minute,
            });
            setSecret(created.secret);
          })
        }
      >
        <Plus />
        {t("createRuntimeKey")}
      </Button>
      <div className="agent-worker-key">
        <p>{t("workspaceWorkerKeyHint")}</p>
        <Button
          variant="secondary"
          onClick={() =>
            void action(async () => {
              if (!agent.allowed_scopes.includes("runtime:worker")) {
                await api.updateAgent(agent.id, {
                  allowed_scopes: [...agent.allowed_scopes, "runtime:worker"],
                });
              }
              const created = await api.createAgentKey(agent.id, {
                name: "workspace-runtime",
                scopes: ["runtime:worker"],
                rate_limit_per_minute: agent.rate_limit_per_minute,
              });
              setSecret(created.secret);
            })
          }
        >
          <Plus />
          {t("createWorkspaceWorkerKey")}
        </Button>
      </div>
      {secret && (
        <div className="agent-secret" role="status">
          <strong>{t("copySecretNow")}</strong>
          <code>{secret}</code>
          <Button
            size="sm"
            onClick={() => void navigator.clipboard.writeText(secret)}
          >
            {t("copy")}
          </Button>
        </div>
      )}
    </SettingsSection>
  );
}
