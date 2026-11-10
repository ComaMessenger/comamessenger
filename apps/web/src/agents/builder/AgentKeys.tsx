import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Agent, MessengerAPI } from "@comamessenger/core";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { messageOf } from "../../errors";
import { Button, Field, FormError, IconButton } from "../../ui";

/*
 * Keys of an external agent and the legacy per-agent provider key. Mounted
 * inside the builder of one agent only, so a shown secret or a typed key never
 * reaches the page of another agent.
 */
export function AgentKeys({
  api,
  agent,
  onChanged,
}: {
  api: MessengerAPI;
  agent: Agent;
  onChanged(): Promise<unknown>;
}) {
  const { t } = useTranslation();
  const [providerKey, setProviderKey] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const keys = useQuery({
    queryKey: ["agent-keys", agent.id],
    queryFn: () => api.agentKeys(agent.id),
  });
  const credential = useQuery({
    queryKey: ["agent-credential", agent.id],
    queryFn: () => api.agentProviderCredential(agent.id),
    enabled: agent.kind === "builtin" && !agent.llm_connection_id,
  });
  async function act(work: () => Promise<unknown>) {
    setError("");
    try {
      await work();
      await Promise.all([keys.refetch(), onChanged()]);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }
  return (
    <section className="agent-keys">
      <h4>{t("agentKeysTitle")}</h4>
      <p className="agent-muted">{t("agentKeysLead")}</p>
      {agent.kind === "builtin" && !agent.llm_connection_id && (
        <form
          className="agent-form-row agent-form-row--action"
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              await api.updateAgentProviderCredential(agent.id, {
                api_key: providerKey,
                clear: false,
              });
              setProviderKey("");
              await credential.refetch();
            });
          }}
        >
          <Field
            required={false}
            type="password"
            autoComplete="off"
            label={t("agentOwnModelKey")}
            name="provider-key"
            value={providerKey}
            placeholder={credential.data?.key_hint || "••••"}
            onChange={(event) => setProviderKey(event.target.value)}
          />
          <Button type="submit" disabled={!providerKey}>
            {t("save")}
          </Button>
        </form>
      )}
      <div className="agent-key-list">
        {(keys.data ?? [])
          .filter((key) => !key.revoked_at)
          .map((key) => (
            <div key={key.id} className="agent-line">
              <span className="agent-line__icon" aria-hidden="true">
                <KeyRound />
              </span>
              <span className="agent-line__text">
                <strong>{key.name}</strong>
                <small>{key.prefix}…</small>
              </span>
              <span className="agent-line__control">
                <IconButton
                  label={t("agentKeyRevoke", { name: key.name })}
                  onClick={() =>
                    void act(() => api.revokeAgentKey(agent.id, key.id))
                  }
                >
                  <Trash2 />
                </IconButton>
              </span>
            </div>
          ))}
      </div>
      <div className="agent-keys__actions">
        <Button
          size="sm"
          onClick={() =>
            void act(async () => {
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
        >
          <Plus />
          {t("createRuntimeKey")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            void act(async () => {
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
        >
          <Plus />
          {t("createWorkspaceWorkerKey")}
        </Button>
      </div>
      <p className="agent-muted">{t("workspaceWorkerKeyHint")}</p>
      {secret && (
        <div className="agent-secret" role="status">
          <strong>{t("copySecretNow")}</strong>
          <code>{secret}</code>
          <Button
            size="sm"
            onClick={() => void navigator.clipboard.writeText(secret)}
          >
            {t("agentCopySecret")}
          </Button>
        </div>
      )}
      <FormError message={error} />
    </section>
  );
}
