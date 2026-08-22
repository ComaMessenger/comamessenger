import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AgentLlmConnection, MessengerAPI } from "@comamessenger/core";
import { Plug, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { messageOf } from "../errors";
import {
  Badge,
  Button,
  Dialog,
  Field,
  FormError,
  SelectField,
  Skeleton,
} from "../ui";

type Provider = "openai" | "anthropic" | "openai-compatible";

type ConnectionDraft = {
  name: string;
  provider: Provider;
  endpoint_url: string;
  default_model: string;
  api_key: string;
};

const emptyDraft: ConnectionDraft = {
  name: "",
  provider: "openai",
  endpoint_url: "",
  default_model: "",
  api_key: "",
};

export function AgentConnectionsPage({
  api,
  canManage,
}: {
  api: MessengerAPI;
  canManage: boolean;
}) {
  const { t } = useTranslation();
  const connections = useQuery({
    queryKey: ["agent-llm-connections"],
    queryFn: () => api.agentLlmConnections(),
  });
  const [draft, setDraft] = useState<ConnectionDraft>(emptyDraft);
  const [createOpen, setCreateOpen] = useState(false);
  const [pendingID, setPendingID] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function createConnection() {
    setPendingID("new");
    setError("");
    try {
      await api.createAgentLlmConnection({ ...draft, enabled: true });
      await connections.refetch();
      setDraft(emptyDraft);
      setCreateOpen(false);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPendingID(null);
    }
  }

  async function updateConnection(
    connection: AgentLlmConnection,
    input: { enabled: boolean },
  ) {
    setPendingID(connection.id);
    setError("");
    try {
      await api.updateAgentLlmConnection(connection.id, input);
      await connections.refetch();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPendingID(null);
    }
  }

  async function deleteConnection(connection: AgentLlmConnection) {
    setPendingID(connection.id);
    setError("");
    try {
      await api.deleteAgentLlmConnection(connection.id);
      await connections.refetch();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPendingID(null);
    }
  }

  return (
    <div className="agent-global-page">
      <div className="agent-global-page__title">
        <div>
          <h2>{t("agentConnectionsTitle")}</h2>
          <p>{t("agentConnectionsDescription")}</p>
        </div>
        {canManage && (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus />
            {t("agentConnectionAdd")}
          </Button>
        )}
      </div>
      <FormError message={error} />
      {connections.isLoading ? (
        <Skeleton />
      ) : connections.data?.length ? (
        <div className="agent-connection-grid">
          {connections.data.map((connection) => (
            <article key={connection.id} className="agent-connection-card">
              <span className="agent-connection-card__icon">
                <Plug />
              </span>
              <div>
                <h3>{connection.name}</h3>
                <p>
                  {t(`agentProvider_${connection.provider}`)} ·{" "}
                  {connection.default_model || t("agentConnectionModelUnset")}
                </p>
              </div>
              <Badge
                tone={
                  connection.health_status === "healthy"
                    ? "success"
                    : connection.health_status === "unhealthy"
                      ? "neutral"
                      : "neutral"
                }
              >
                {t(`agentConnectionHealth_${connection.health_status}`)}
              </Badge>
              <dl>
                <div>
                  <dt>{t("providerKey")}</dt>
                  <dd>{connection.key_hint}</dd>
                </div>
                {connection.endpoint_url && (
                  <div>
                    <dt>Endpoint</dt>
                    <dd>{connection.endpoint_url}</dd>
                  </div>
                )}
              </dl>
              {canManage && (
                <div className="agent-connection-card__actions">
                  <Button
                    size="sm"
                    disabled={pendingID === connection.id}
                    onClick={async () => {
                      setPendingID(connection.id);
                      setError("");
                      try {
                        await api.testAgentLlmConnection(connection.id);
                        await connections.refetch();
                      } catch (cause) {
                        setError(messageOf(cause));
                      } finally {
                        setPendingID(null);
                      }
                    }}
                  >
                    {t("testConnection")}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={pendingID === connection.id}
                    onClick={() =>
                      void updateConnection(connection, {
                        enabled: !connection.enabled,
                      })
                    }
                  >
                    {connection.enabled ? t("disable") : t("enable")}
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    disabled={pendingID === connection.id}
                    aria-label={t("delete")}
                    onClick={() => void deleteConnection(connection)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              )}
            </article>
          ))}
        </div>
      ) : (
        <div className="agent-empty-state">
          <Plug />
          <h3>{t("agentConnectionsEmpty")}</h3>
          <p>{t("agentConnectionsEmptyHint")}</p>
        </div>
      )}
      {createOpen && (
        <Dialog
          title={t("agentConnectionCreateTitle")}
          description={t("agentConnectionCreateDescription")}
          onClose={() => setCreateOpen(false)}
        >
          <div className="agent-connection-form">
            <Field
              label={t("name")}
              name="connection-name"
              value={draft.name}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  name: event.target.value,
                }))
              }
            />
            <SelectField
              label={t("provider")}
              name="connection-provider"
              value={draft.provider}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  provider: event.target.value as Provider,
                  endpoint_url:
                    event.target.value === "openai-compatible"
                      ? current.endpoint_url
                      : "",
                }))
              }
            >
              {(["openai", "anthropic", "openai-compatible"] as const).map(
                (provider) => (
                  <option key={provider} value={provider}>
                    {t(`agentProvider_${provider}`)}
                  </option>
                ),
              )}
            </SelectField>
            {draft.provider === "openai-compatible" && (
              <Field
                label="Endpoint"
                name="connection-endpoint"
                placeholder="http://localhost:11434/v1"
                value={draft.endpoint_url}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    endpoint_url: event.target.value,
                  }))
                }
              />
            )}
            <Field
              required={false}
              label={t("defaultModel")}
              name="connection-model"
              value={draft.default_model}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  default_model: event.target.value,
                }))
              }
            />
            <Field
              type="password"
              label={t("providerKey")}
              name="connection-key"
              autoComplete="new-password"
              value={draft.api_key}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  api_key: event.target.value,
                }))
              }
            />
            <p className="agent-connection-form__security">
              {t("agentConnectionSecurityHint")}
            </p>
            <FormError message={error} />
          </div>
          <div className="ui-dialog__actions">
            <Button
              variant="ghost"
              disabled={pendingID === "new"}
              onClick={() => setCreateOpen(false)}
            >
              {t("cancel")}
            </Button>
            <Button
              disabled={
                pendingID === "new" ||
                !draft.name.trim() ||
                !draft.api_key.trim() ||
                (draft.provider === "openai-compatible" &&
                  !draft.endpoint_url.trim())
              }
              onClick={() => void createConnection()}
            >
              {pendingID === "new" ? t("saving") : t("save")}
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
