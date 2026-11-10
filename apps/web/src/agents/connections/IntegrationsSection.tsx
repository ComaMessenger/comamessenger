import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  IntegrationWebhook,
  IntegrationWebhookWithSecret,
  McpConnection,
  McpConnectionUsage,
  MessengerAPI,
} from "@comamessenger/core";
import {
  Cable,
  Copy,
  History,
  KeyRound,
  Plus,
  Trash2,
  Webhook,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { messageOf } from "../../errors";
import {
  Badge,
  Button,
  Dialog,
  Field,
  FormError,
  Skeleton,
  Switch,
  TextareaField,
} from "../../ui";
import "./integrations.css";

/**
 * Workspace integrations next to the LLM connections: MCP connections of
 * external systems and signed incoming webhooks. Secrets are typed once and
 * never come back from the server; a webhook secret is shown exactly once.
 */
export function IntegrationsSection({
  api,
  canManage,
}: {
  api: MessengerAPI;
  canManage: boolean;
}) {
  const { t } = useTranslation();
  return (
    <section className="integrations" aria-labelledby="integrations-title">
      <div className="agent-global-page__title">
        <div>
          <h2 id="integrations-title">{t("integrationsTitle")}</h2>
          <p>{t("integrationsDescription")}</p>
        </div>
      </div>
      <McpConnections api={api} canManage={canManage} />
      {canManage && <Webhooks api={api} />}
    </section>
  );
}

type McpDraft = {
  name: string;
  description: string;
  endpoint_url: string;
  header_name: string;
  header_value: string;
  allow_private_network: boolean;
  agent_use_allowed: boolean;
  writes_require_confirmation: boolean;
};

const emptyMcpDraft: McpDraft = {
  name: "",
  description: "",
  endpoint_url: "",
  header_name: "Authorization",
  header_value: "",
  allow_private_network: false,
  agent_use_allowed: false,
  writes_require_confirmation: true,
};

function McpConnections({
  api,
  canManage,
}: {
  api: MessengerAPI;
  canManage: boolean;
}) {
  const { t } = useTranslation();
  const connections = useQuery({
    queryKey: ["mcp-connections"],
    queryFn: () => api.mcpConnections(),
  });
  const [draft, setDraft] = useState<McpDraft>(emptyMcpDraft);
  const [createOpen, setCreateOpen] = useState(false);
  const [detaching, setDetaching] = useState<McpConnection | null>(null);
  const [pendingID, setPendingID] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function run(id: string, action: () => Promise<unknown>) {
    setPendingID(id);
    setError("");
    try {
      await action();
      await connections.refetch();
      return true;
    } catch (cause) {
      setError(messageOf(cause));
      return false;
    } finally {
      setPendingID(null);
    }
  }

  async function create() {
    const headers =
      draft.header_name.trim() && draft.header_value.trim()
        ? { [draft.header_name.trim()]: draft.header_value.trim() }
        : undefined;
    const created = await run("new", () =>
      api.createMcpConnection({
        name: draft.name.trim(),
        description: draft.description.trim(),
        endpoint_url: draft.endpoint_url.trim(),
        enabled: true,
        allow_private_network: draft.allow_private_network,
        agent_use_allowed: draft.agent_use_allowed,
        writes_require_confirmation: draft.writes_require_confirmation,
        ...(headers ? { headers } : {}),
      }),
    );
    if (created) {
      setDraft(emptyMcpDraft);
      setCreateOpen(false);
    }
  }

  return (
    <div className="integrations__block">
      <div className="integrations__heading">
        <div>
          <h3>{t("mcpConnectionsTitle")}</h3>
          <p>{t("mcpConnectionsDescription")}</p>
        </div>
        {canManage && (
          <Button variant="secondary" onClick={() => setCreateOpen(true)}>
            <Plus />
            {t("mcpConnectionAdd")}
          </Button>
        )}
      </div>
      {!createOpen && <FormError message={error} />}
      {connections.isLoading ? (
        <Skeleton />
      ) : connections.data?.length ? (
        <div className="agent-connection-grid">
          {connections.data.map((connection) => (
            <article
              key={connection.id}
              className="agent-connection-card"
              data-testid="mcp-connection"
            >
              <span className="agent-connection-card__icon">
                <Cable />
              </span>
              <div>
                <h3>{connection.name}</h3>
                <p>{connection.description || connection.endpoint_url}</p>
              </div>
              <Badge
                tone={
                  connection.health_status === "healthy" ? "success" : "neutral"
                }
              >
                {connection.enabled
                  ? t(`agentConnectionHealth_${connection.health_status}`)
                  : t("integrationDisabled")}
              </Badge>
              <dl>
                <div>
                  <dt>Endpoint</dt>
                  <dd>
                    {connection.endpoint_url}
                    {connection.allow_private_network &&
                      ` · ${t("mcpConnectionPrivate")}`}
                  </dd>
                </div>
                <div>
                  <dt>{t("mcpConnectionSecret")}</dt>
                  <dd>
                    {connection.secret_hint || t("mcpConnectionNoSecret")}
                  </dd>
                </div>
                <div>
                  <dt>{t("mcpConnectionAgents")}</dt>
                  <dd>
                    {connection.agent_count
                      ? t("mcpConnectionAgentCount", {
                          count: connection.agent_count,
                        })
                      : t("mcpConnectionUnused")}
                  </dd>
                </div>
                <div>
                  <dt>{t("mcpConnectionPolicy")}</dt>
                  <dd>
                    {connection.agent_use_allowed
                      ? t("mcpConnectionAgentUseOn")
                      : t("mcpConnectionAgentUseOff")}
                    {" · "}
                    {connection.writes_require_confirmation
                      ? t("mcpConnectionWritesConfirmedOn")
                      : t("mcpConnectionWritesConfirmedOff")}
                  </dd>
                </div>
                <div>
                  <dt>{t("mcpConnectionTools")}</dt>
                  <dd>
                    {connection.tools.length ? (
                      <ul className="integrations__tools">
                        {connection.tools.map((tool) => {
                          const assignable =
                            connection.assignable_tools == null ||
                            connection.assignable_tools.includes(tool.name);
                          return (
                            <li key={tool.name} title={tool.description}>
                              {canManage && (
                                <Switch
                                  label={t("mcpToolAssignable", {
                                    tool: tool.name,
                                  })}
                                  checked={assignable}
                                  disabled={pendingID === connection.id}
                                  onChange={(value) => {
                                    const current =
                                      connection.assignable_tools ??
                                      connection.tools.map((item) => item.name);
                                    const next = value
                                      ? [...current, tool.name]
                                      : current.filter(
                                          (name) => name !== tool.name,
                                        );
                                    void run(connection.id, () =>
                                      api.updateMcpConnection(connection.id, {
                                        assignable_tools: next,
                                      }),
                                    );
                                  }}
                                />
                              )}
                              <code>{tool.name}</code>
                              <Badge tone={tool.read_only ? "soft" : "primary"}>
                                {tool.read_only
                                  ? t("mcpToolRead")
                                  : t("mcpToolWrite")}
                              </Badge>
                              {!assignable && (
                                <span className="integrations__muted">
                                  {t("mcpToolNotAssignable")}
                                </span>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      t("mcpConnectionToolsUnknown")
                    )}
                  </dd>
                </div>
                {connection.last_error_code && (
                  <div>
                    <dt>{t("mcpConnectionLastTested")}</dt>
                    <dd>
                      {t("mcpConnectionError", {
                        code: connection.last_error_code,
                      })}
                    </dd>
                  </div>
                )}
              </dl>
              {canManage && (
                <div className="agent-connection-card__actions">
                  <Button
                    size="sm"
                    disabled={pendingID === connection.id}
                    onClick={() =>
                      void run(connection.id, () =>
                        api.testMcpConnection(connection.id),
                      )
                    }
                  >
                    {t("testConnection")}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={pendingID === connection.id}
                    onClick={() =>
                      void run(connection.id, () =>
                        api.updateMcpConnection(connection.id, {
                          enabled: !connection.enabled,
                        }),
                      )
                    }
                  >
                    {connection.enabled ? t("disable") : t("enable")}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={pendingID === connection.id}
                    onClick={() =>
                      void run(connection.id, () =>
                        api.updateMcpConnection(connection.id, {
                          agent_use_allowed: !connection.agent_use_allowed,
                        }),
                      )
                    }
                  >
                    {connection.agent_use_allowed
                      ? t("mcpConnectionAgentUseRevoke")
                      : t("mcpConnectionAgentUseGrant")}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={pendingID === connection.id}
                    onClick={() =>
                      void run(connection.id, () =>
                        api.updateMcpConnection(connection.id, {
                          writes_require_confirmation:
                            !connection.writes_require_confirmation,
                        }),
                      )
                    }
                  >
                    {connection.writes_require_confirmation
                      ? t("mcpConnectionWritesConfirmedRelax")
                      : t("mcpConnectionWritesConfirmedRequire")}
                  </Button>
                  {connection.agent_count > 0 ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pendingID === connection.id}
                      onClick={() => setDetaching(connection)}
                    >
                      {t("mcpConnectionDetach")}
                    </Button>
                  ) : (
                    <Button
                      size="icon"
                      variant="ghost"
                      disabled={pendingID === connection.id}
                      aria-label={t("delete")}
                      onClick={() =>
                        void run(connection.id, () =>
                          api.deleteMcpConnection(connection.id),
                        )
                      }
                    >
                      <Trash2 />
                    </Button>
                  )}
                </div>
              )}
            </article>
          ))}
        </div>
      ) : (
        <div className="agent-empty-state">
          <Cable />
          <h3>{t("mcpConnectionsEmpty")}</h3>
          <p>{t("mcpConnectionsEmptyHint")}</p>
        </div>
      )}
      {createOpen && (
        <Dialog
          title={t("mcpConnectionCreateTitle")}
          description={t("mcpConnectionCreateDescription")}
          onClose={() => setCreateOpen(false)}
        >
          <div className="agent-connection-form">
            <Field
              label={t("mcpConnectionName")}
              name="mcp-name"
              hint={t("mcpConnectionNameHint")}
              placeholder="accounting"
              value={draft.name}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  name: event.target.value.toLowerCase(),
                }))
              }
            />
            <Field
              required={false}
              label={t("mcpConnectionDescriptionField")}
              name="mcp-description"
              value={draft.description}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  description: event.target.value,
                }))
              }
            />
            <Field
              label={t("mcpConnectionEndpoint")}
              name="mcp-endpoint"
              placeholder="https://mcp.example.com/mcp"
              value={draft.endpoint_url}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  endpoint_url: event.target.value,
                }))
              }
            />
            <div className="integrations__pair">
              <Field
                required={false}
                label={t("mcpConnectionHeaderName")}
                name="mcp-header-name"
                value={draft.header_name}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    header_name: event.target.value,
                  }))
                }
              />
              <Field
                required={false}
                type="password"
                autoComplete="new-password"
                label={t("mcpConnectionHeaderValue")}
                name="mcp-header-value"
                placeholder="Bearer …"
                value={draft.header_value}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    header_value: event.target.value,
                  }))
                }
              />
            </div>
            <div className="integrations__switch">
              <Switch
                label={t("mcpConnectionPrivate")}
                checked={draft.allow_private_network}
                onChange={(value) =>
                  setDraft((current) => ({
                    ...current,
                    allow_private_network: value,
                  }))
                }
              />
              <div>
                <strong>{t("mcpConnectionPrivate")}</strong>
                <p>{t("mcpConnectionPrivateHint")}</p>
              </div>
            </div>
            <div className="integrations__switch">
              <Switch
                label={t("mcpConnectionAgentUse")}
                checked={draft.agent_use_allowed}
                onChange={(value) =>
                  setDraft((current) => ({
                    ...current,
                    agent_use_allowed: value,
                  }))
                }
              />
              <div>
                <strong>{t("mcpConnectionAgentUse")}</strong>
                <p>{t("mcpConnectionAgentUseHint")}</p>
              </div>
            </div>
            <div className="integrations__switch">
              <Switch
                label={t("mcpConnectionWritesConfirmed")}
                checked={draft.writes_require_confirmation}
                onChange={(value) =>
                  setDraft((current) => ({
                    ...current,
                    writes_require_confirmation: value,
                  }))
                }
              />
              <div>
                <strong>{t("mcpConnectionWritesConfirmed")}</strong>
                <p>{t("mcpConnectionWritesConfirmedHint")}</p>
              </div>
            </div>
            <p className="agent-connection-form__security">
              {t("mcpConnectionSecurityHint")}
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
              variant="primary"
              disabled={
                pendingID === "new" ||
                !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(draft.name.trim()) ||
                !draft.endpoint_url.trim()
              }
              onClick={() => void create()}
            >
              {pendingID === "new" ? t("saving") : t("save")}
            </Button>
          </div>
        </Dialog>
      )}
      {detaching && (
        <DetachDialog
          api={api}
          connection={detaching}
          onClose={() => setDetaching(null)}
          onDone={async () => {
            setDetaching(null);
            await connections.refetch();
          }}
        />
      )}
    </div>
  );
}

function DetachDialog({
  api,
  connection,
  onClose,
  onDone,
}: {
  api: MessengerAPI;
  connection: McpConnection;
  onClose(): void;
  onDone(): Promise<void>;
}) {
  const { t } = useTranslation();
  const usage = useQuery({
    queryKey: ["mcp-connection-usage", connection.id],
    queryFn: () => api.mcpConnectionUsage(connection.id),
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const affected: McpConnectionUsage[] = usage.data ?? [];

  async function detach() {
    setPending(true);
    setError("");
    try {
      await api.detachMcpConnection(
        connection.id,
        affected.map((item) => item.agent_id),
      );
      await onDone();
    } catch (cause) {
      setError(messageOf(cause));
      await usage.refetch();
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      title={t("mcpConnectionDetachTitle", { name: connection.name })}
      description={t("mcpConnectionDetachDescription")}
      onClose={onClose}
    >
      {usage.isLoading ? (
        <Skeleton />
      ) : (
        <ul className="integrations__usage">
          {affected.map((item) => (
            <li key={item.agent_id}>
              <strong>{item.display_name}</strong>
              <span>
                {[
                  item.published && t("mcpConnectionDetachPublished"),
                  item.draft && t("mcpConnectionDetachDraft"),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              <code>{item.allowed_tools.join(", ")}</code>
            </li>
          ))}
        </ul>
      )}
      <FormError message={error} />
      <div className="ui-dialog__actions">
        <Button variant="ghost" disabled={pending} onClick={onClose}>
          {t("cancel")}
        </Button>
        <Button
          variant="primary"
          disabled={pending || usage.isLoading || affected.length === 0}
          onClick={() => void detach()}
        >
          {t("mcpConnectionDetachConfirm", { count: affected.length })}
        </Button>
      </div>
    </Dialog>
  );
}

export function webhookURL(api: MessengerAPI, id: string): string {
  return new URL(
    `/api/v1/hooks/${encodeURIComponent(id)}`,
    api.apiURL || window.location.origin,
  ).toString();
}

function Webhooks({ api }: { api: MessengerAPI }) {
  const { t, i18n } = useTranslation();
  const webhooks = useQuery({
    queryKey: ["integration-webhooks"],
    queryFn: () => api.integrationWebhooks(),
  });
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [revealed, setRevealed] = useState<IntegrationWebhookWithSecret | null>(
    null,
  );
  const [journal, setJournal] = useState<IntegrationWebhook | null>(null);
  const [pendingID, setPendingID] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function run<T>(id: string, action: () => Promise<T>) {
    setPendingID(id);
    setError("");
    try {
      const result = await action();
      await webhooks.refetch();
      return result;
    } catch (cause) {
      setError(messageOf(cause));
      return null;
    } finally {
      setPendingID(null);
    }
  }

  return (
    <div className="integrations__block">
      <div className="integrations__heading">
        <div>
          <h3>{t("webhooksTitle")}</h3>
          <p>{t("webhooksDescription")}</p>
        </div>
        <Button variant="secondary" onClick={() => setCreateOpen(true)}>
          <Plus />
          {t("webhookAdd")}
        </Button>
      </div>
      {!createOpen && <FormError message={error} />}
      {webhooks.isLoading ? (
        <Skeleton />
      ) : webhooks.data?.length ? (
        <div className="agent-connection-grid">
          {webhooks.data.map((hook) => (
            <article
              key={hook.id}
              className="agent-connection-card"
              data-testid="integration-webhook"
            >
              <span className="agent-connection-card__icon">
                <Webhook />
              </span>
              <div>
                <h3>{hook.name}</h3>
                {hook.description && <p>{hook.description}</p>}
              </div>
              <Badge tone={hook.enabled ? "success" : "neutral"}>
                {hook.enabled
                  ? t("integrationEnabled")
                  : t("integrationDisabled")}
              </Badge>
              <dl>
                <div>
                  <dt>{t("webhookURL")}</dt>
                  <dd>
                    <code>{webhookURL(api, hook.id)}</code>
                  </dd>
                </div>
                <div>
                  <dt>{t("webhookSecret")}</dt>
                  <dd>{hook.secret_hint}</dd>
                </div>
                <div>
                  <dt>{t("webhookTriggers")}</dt>
                  <dd>{hook.trigger_count}</dd>
                </div>
                {hook.rejected_count > 0 && (
                  <div>
                    <dt>{t("webhookRejected")}</dt>
                    <dd>
                      {t("webhookRejectedSummary", {
                        count: hook.rejected_count,
                        code: hook.last_rejected_code,
                      })}
                    </dd>
                  </div>
                )}
                <div>
                  <dt>{t("webhookLastReceived")}</dt>
                  <dd>
                    {hook.last_received_at
                      ? new Date(hook.last_received_at).toLocaleString(
                          i18n.language,
                        )
                      : t("webhookNever")}
                  </dd>
                </div>
              </dl>
              <div className="agent-connection-card__actions">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setJournal(hook)}
                >
                  <History />
                  {t("webhookJournal")}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={pendingID === hook.id}
                  onClick={async () => {
                    const rotated = await run(hook.id, () =>
                      api.rotateIntegrationWebhookSecret(hook.id),
                    );
                    if (rotated) setRevealed(rotated);
                  }}
                >
                  <KeyRound />
                  {t("webhookRotate")}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={pendingID === hook.id}
                  onClick={() =>
                    void run(hook.id, () =>
                      api.updateIntegrationWebhook(hook.id, {
                        enabled: !hook.enabled,
                      }),
                    )
                  }
                >
                  {hook.enabled ? t("disable") : t("enable")}
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={pendingID === hook.id || hook.trigger_count > 0}
                  title={
                    hook.trigger_count > 0
                      ? t("webhookDeleteBlocked")
                      : undefined
                  }
                  aria-label={t("delete")}
                  onClick={() =>
                    void run(hook.id, () =>
                      api.deleteIntegrationWebhook(hook.id),
                    )
                  }
                >
                  <Trash2 />
                </Button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="agent-empty-state">
          <Webhook />
          <h3>{t("webhooksEmpty")}</h3>
          <p>{t("webhooksEmptyHint")}</p>
        </div>
      )}
      {createOpen && (
        <Dialog
          title={t("webhookCreateTitle")}
          description={t("webhookCreateDescription")}
          onClose={() => setCreateOpen(false)}
        >
          <div className="agent-connection-form">
            <Field
              label={t("webhookName")}
              name="webhook-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <TextareaField
              required={false}
              label={t("webhookDescriptionField")}
              name="webhook-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
            <FormError message={error} />
          </div>
          <div className="ui-dialog__actions">
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              {t("cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={pendingID === "new" || !name.trim()}
              onClick={async () => {
                const created = await run("new", () =>
                  api.createIntegrationWebhook({
                    name: name.trim(),
                    description: description.trim(),
                    enabled: true,
                  }),
                );
                if (created) {
                  setCreateOpen(false);
                  setName("");
                  setDescription("");
                  setRevealed(created);
                }
              }}
            >
              {pendingID === "new" ? t("saving") : t("save")}
            </Button>
          </div>
        </Dialog>
      )}
      {revealed && (
        <SecretOnceDialog
          url={webhookURL(api, revealed.id)}
          secret={revealed.secret}
          onClose={() => setRevealed(null)}
        />
      )}
      {journal && (
        <JournalDialog
          api={api}
          webhook={journal}
          onClose={() => setJournal(null)}
        />
      )}
    </div>
  );
}

function SecretOnceDialog({
  url,
  secret,
  onClose,
}: {
  url: string;
  secret: string;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <Dialog
      title={t("webhookSecretOnceTitle")}
      description={t("webhookSecretOnceDescription")}
      onClose={onClose}
    >
      <dl className="integrations__secret">
        <dt>{t("webhookURL")}</dt>
        <dd>
          <code>{url}</code>
        </dd>
        <dt>{t("webhookSecret")}</dt>
        <dd>
          <code data-testid="webhook-secret">{secret}</code>
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(secret);
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}
          >
            <Copy />
            {copied ? t("copied") : t("copy")}
          </Button>
        </dd>
      </dl>
      <p className="agent-connection-form__security">
        {t("webhookSigningHint")}
      </p>
      <div className="ui-dialog__actions">
        <Button variant="primary" onClick={onClose}>
          {t("webhookSecretSaved")}
        </Button>
      </div>
    </Dialog>
  );
}

function JournalDialog({
  api,
  webhook,
  onClose,
}: {
  api: MessengerAPI;
  webhook: IntegrationWebhook;
  onClose(): void;
}) {
  const { t, i18n } = useTranslation();
  const deliveries = useQuery({
    queryKey: ["integration-webhook-deliveries", webhook.id],
    queryFn: () => api.integrationWebhookDeliveries(webhook.id),
  });
  return (
    <Dialog
      title={t("webhookJournalTitle", { name: webhook.name })}
      onClose={onClose}
      size="lg"
    >
      {deliveries.isLoading ? (
        <Skeleton />
      ) : deliveries.data?.length ? (
        <ul className="integrations__journal">
          {deliveries.data.map((delivery) => (
            <li key={delivery.id}>
              <time dateTime={delivery.received_at}>
                {new Date(delivery.received_at).toLocaleString(i18n.language)}
              </time>
              <Badge
                tone={delivery.status === "accepted" ? "success" : "danger"}
              >
                {t(`webhookDelivery_${delivery.status}`)}
              </Badge>
              <code>{delivery.event_type || "—"}</code>
              <span>
                {delivery.status === "accepted"
                  ? t("webhookRunsCreated", { count: delivery.runs_created })
                  : delivery.error_code}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p>{t("webhookJournalEmpty")}</p>
      )}
    </Dialog>
  );
}
