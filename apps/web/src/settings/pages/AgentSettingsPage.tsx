import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  Agent,
  AgentRun,
  AgentScope,
  Chat,
  CreateAgentRequest,
  MessengerAPI,
  User,
} from "@comamessenger/core";
import { Bot, KeyRound, Play, Plus, Save, Trash2, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import { messageOf } from "../../errors";
import {
  Badge,
  Button,
  Field,
  FormError,
  SelectField,
  Skeleton,
  TextareaField,
} from "../../ui";
import {
  SettingsAccessDenied,
  SettingsSection,
  SettingsToggle,
} from "../components/SettingsPrimitives";
import {
  SettingsShell,
  type SettingsNavigate,
} from "../components/SettingsShell";
import { canAccessSettingsPage } from "../registry";
import {
  builtinTriggerRequests,
  type AgentTemplate as Template,
} from "../agentTemplates";

const scopes: AgentScope[] = [
  "chats:read",
  "messages:read",
  "messages:write",
  "reactions:write",
  "files:read",
  "search:read",
  "members:read",
  "memory:read",
  "memory:write",
  "runtime:execute",
];

type Draft = CreateAgentRequest;

const templateDescriptions: Record<Template, string> = {
  custom: "",
  summarizer:
    "You are the workspace Summarizer. On /summarize, summarize the current chat or thread with decisions, open questions and action items. For scheduled runs, produce a concise digest. Use message IDs as citations and never invent facts.",
  qa: "You answer questions from accessible workspace history and extracted files. Search before answering, cite the exact message or file identifiers used, distinguish evidence from inference, and say when the answer is not available.",
  onboarding:
    "You are the onboarding guide. Greet new members in the configured chat, explain the workspace using only accessible history and files, link to source message IDs, and answer follow-up questions without exposing private chats.",
};

function emptyDraft(template: Template = "custom"): Draft {
  const suffix = Math.random().toString(36).slice(2, 7);
  return {
    display_name:
      template === "summarizer"
        ? "Summarizer"
        : template === "qa"
          ? "Workspace Q&A"
          : template === "onboarding"
            ? "Onboarding"
            : "New agent",
    handle: `${template === "custom" ? "agent" : template}_${suffix}`,
    kind: "builtin",
    description: templateDescriptions[template],
    enabled: false,
    allowed_scopes:
      template === "onboarding"
        ? [
            "messages:read",
            "messages:write",
            "search:read",
            "files:read",
            "runtime:execute",
          ]
        : [
            "messages:read",
            "messages:write",
            "search:read",
            "files:read",
            "memory:read",
            "memory:write",
            "runtime:execute",
          ],
    provider: "openai",
    model: "gpt-5-mini",
    endpoint_url: "",
    external_data_sharing_approved: false,
    daily_cost_limit: "",
    monthly_cost_limit: "",
    max_output_tokens: 2048,
    max_tool_iterations: 8,
    max_chain_depth: 3,
    per_chat_concurrency: 1,
    rate_limit_per_minute: 60,
    provider_rate_limit_per_minute: 300,
    chat_ids: [],
  };
}

function draftOf(agent: Agent): Draft {
  return {
    display_name: agent.display_name,
    handle: agent.handle,
    kind: agent.kind,
    description: agent.description,
    enabled: agent.enabled,
    allowed_scopes: agent.allowed_scopes,
    provider: agent.provider,
    model: agent.model,
    endpoint_url: agent.endpoint_url ?? "",
    external_data_sharing_approved: agent.external_data_sharing_approved,
    daily_cost_limit: agent.daily_cost_limit ?? "",
    monthly_cost_limit: agent.monthly_cost_limit ?? "",
    max_output_tokens: agent.max_output_tokens,
    max_tool_iterations: agent.max_tool_iterations,
    max_chain_depth: agent.max_chain_depth,
    per_chat_concurrency: agent.per_chat_concurrency,
    rate_limit_per_minute: agent.rate_limit_per_minute,
    provider_rate_limit_per_minute: agent.provider_rate_limit_per_minute,
    chat_ids: agent.chat_ids,
  };
}

export function AgentSettingsPage({
  api,
  user,
  navigate,
}: {
  api: MessengerAPI;
  user: User;
  navigate: SettingsNavigate;
}) {
  const { t } = useTranslation();
  const allowed = canAccessSettingsPage(user, "agents");
  const agents = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.agents(),
    enabled: allowed,
  });
  const chats = useQuery({
    queryKey: ["agent-chats"],
    queryFn: () => api.chats(),
    enabled: allowed,
  });
  const [selectedID, setSelectedID] = useState<string | null>(null);
  const [template, setTemplate] = useState<Template>("custom");
  const [draft, setDraft] = useState<Draft>(() => ({
    ...emptyDraft(),
    display_name: t("agentTemplate_custom"),
  }));
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const selected = agents.data?.find((agent) => agent.id === selectedID);
  useEffect(() => {
    if (selected) setDraft(draftOf(selected));
  }, [selected]);
  useEffect(() => {
    if (!selectedID && agents.data?.length) setSelectedID(agents.data[0]!.id);
  }, [agents.data, selectedID]);

  function chooseTemplate(value: Template) {
    setTemplate(value);
    setSelectedID(null);
    setDraft({
      ...emptyDraft(value),
      display_name: t(`agentTemplate_${value}`),
      description:
        value === "custom" ? "" : t(`agentTemplateDescription_${value}`),
    });
    setError("");
  }

  async function save() {
    if (!selected && template !== "custom" && draft.chat_ids.length === 0) {
      setError(t("agentTemplateChatRequired"));
      return;
    }
    setPending(true);
    setError("");
    setNotice("");
    try {
      let saved: Agent;
      if (selected) {
        saved = await api.updateAgent(selected.id, {
          display_name: draft.display_name,
          handle: draft.handle,
          description: draft.description,
          enabled: draft.enabled,
          allowed_scopes: draft.allowed_scopes,
          provider: draft.provider,
          model: draft.model,
          endpoint_url: draft.endpoint_url,
          external_data_sharing_approved: draft.external_data_sharing_approved,
          daily_cost_limit: draft.daily_cost_limit,
          monthly_cost_limit: draft.monthly_cost_limit,
          max_output_tokens: draft.max_output_tokens,
          max_tool_iterations: draft.max_tool_iterations,
          max_chain_depth: draft.max_chain_depth,
          per_chat_concurrency: draft.per_chat_concurrency,
          rate_limit_per_minute: draft.rate_limit_per_minute,
          provider_rate_limit_per_minute: draft.provider_rate_limit_per_minute,
          chat_ids: draft.chat_ids,
        });
      } else {
        saved = await api.createAgent(draft);
        await createTemplateTriggers(api, saved, template, chats.data ?? []);
        setSelectedID(saved.id);
      }
      await agents.refetch();
      setNotice(t("agentSaved"));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <SettingsShell
      user={user}
      active="agents"
      title={t("agentsTitle")}
      navigate={navigate}
    >
      {!allowed ? (
        <SettingsAccessDenied />
      ) : agents.isLoading || chats.isLoading ? (
        <Skeleton />
      ) : (
        <div className="agent-settings">
          <aside className="agent-catalog">
            <Button onClick={() => chooseTemplate("custom")}>
              <Plus />
              {t("createAgent")}
            </Button>
            <div className="agent-template-row">
              {(["summarizer", "qa", "onboarding"] as const).map((item) => (
                <button key={item} onClick={() => chooseTemplate(item)}>
                  <Zap />
                  <span>{t(`agentTemplate_${item}`)}</span>
                </button>
              ))}
            </div>
            {(agents.data ?? []).map((agent) => (
              <button
                key={agent.id}
                className={selectedID === agent.id ? "active" : ""}
                onClick={() => setSelectedID(agent.id)}
              >
                <Bot />
                <span>
                  <strong>{agent.display_name}</strong>
                  <small>
                    @{agent.handle} ·{" "}
                    {agent.enabled ? t("enabled") : t("disabled")}
                  </small>
                </span>
              </button>
            ))}
          </aside>
          <div className="agent-editor">
            <div className="agent-editor__toolbar">
              <div>
                <h2>
                  {selected?.display_name ?? t(`agentTemplate_${template}`)}
                </h2>
                <p>{selected ? `@${selected.handle}` : t("newAgentHint")}</p>
              </div>
              <Button disabled={pending} onClick={() => void save()}>
                <Save />
                {pending ? t("saving") : t("save")}
              </Button>
            </div>
            <FormError message={error} />
            {notice && <Badge tone="success">{notice}</Badge>}
            <AgentConfiguration
              draft={draft}
              chats={chats.data ?? []}
              onChange={setDraft}
            />
            {selected && (
              <AgentOperations
                api={api}
                agent={selected}
                onChanged={() => void agents.refetch()}
              />
            )}
          </div>
        </div>
      )}
    </SettingsShell>
  );
}

function AgentConfiguration({
  draft,
  chats,
  onChange,
}: {
  draft: Draft;
  chats: Chat[];
  onChange(value: Draft): void;
}) {
  const { t } = useTranslation();
  const number = (
    key:
      | "max_output_tokens"
      | "max_tool_iterations"
      | "max_chain_depth"
      | "per_chat_concurrency"
      | "rate_limit_per_minute"
      | "provider_rate_limit_per_minute",
    value: string,
  ) => onChange({ ...draft, [key]: Number(value) });
  return (
    <>
      <SettingsSection
        title={t("agentIdentity")}
        description={t("agentIdentityHint")}
        icon={<Bot />}
        wide
      >
        <div className="settings-form-grid">
          <Field
            label={t("displayName")}
            name="agent-name"
            value={draft.display_name}
            onChange={(e) =>
              onChange({ ...draft, display_name: e.target.value })
            }
          />
          <Field
            label={t("handle")}
            name="agent-handle"
            value={draft.handle}
            onChange={(e) =>
              onChange({ ...draft, handle: e.target.value.toLowerCase() })
            }
          />
          <SelectField
            label={t("provider")}
            name="agent-provider"
            value={draft.provider}
            onChange={(e) => onChange({ ...draft, provider: e.target.value })}
          >
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
            <option value="openai-compatible">{t("openAICompatible")}</option>
          </SelectField>
          <Field
            label={t("model")}
            name="agent-model"
            value={draft.model ?? ""}
            onChange={(e) => onChange({ ...draft, model: e.target.value })}
          />
        </div>
        <TextareaField
          label={t("agentInstructions")}
          name="agent-description"
          rows={5}
          value={draft.description ?? ""}
          onChange={(e) => onChange({ ...draft, description: e.target.value })}
        />
        <SettingsToggle
          label={t("agentEnabled")}
          hint={t("agentEnabledHint")}
          checked={draft.enabled}
          onChange={(enabled) => onChange({ ...draft, enabled })}
        />
        <SettingsToggle
          label={t("externalDataSharing")}
          hint={t("externalDataSharingHint")}
          checked={draft.external_data_sharing_approved}
          onChange={(external_data_sharing_approved) =>
            onChange({ ...draft, external_data_sharing_approved })
          }
        />
      </SettingsSection>
      <SettingsSection
        title={t("agentPermissions")}
        description={t("agentPermissionsHint")}
        wide
      >
        <div className="agent-check-grid">
          {scopes.map((scope) => (
            <label key={scope}>
              <input
                type="checkbox"
                checked={draft.allowed_scopes.includes(scope)}
                onChange={(e) =>
                  onChange({
                    ...draft,
                    allowed_scopes: e.target.checked
                      ? [...draft.allowed_scopes, scope]
                      : draft.allowed_scopes.filter((item) => item !== scope),
                  })
                }
              />
              <span>{t(`agentScope_${scope.replace(":", "_")}`)}</span>
            </label>
          ))}
        </div>
      </SettingsSection>
      <SettingsSection
        title={t("agentChats")}
        description={t("agentChatsHint")}
        wide
      >
        <div className="agent-check-grid">
          {chats.map((chat) => (
            <label key={chat.id}>
              <input
                type="checkbox"
                checked={draft.chat_ids.includes(chat.id)}
                onChange={(e) =>
                  onChange({
                    ...draft,
                    chat_ids: e.target.checked
                      ? [...draft.chat_ids, chat.id]
                      : draft.chat_ids.filter((id) => id !== chat.id),
                  })
                }
              />
              <span>
                {chat.name || chat.direct_peer?.display_name || chat.id}
              </span>
            </label>
          ))}
        </div>
      </SettingsSection>
      <SettingsSection
        title={t("agentLimits")}
        description={t("agentLimitsHint")}
        wide
      >
        <div className="settings-form-grid">
          <Field
            required={false}
            label={t("dailyBudget")}
            name="daily-budget"
            value={draft.daily_cost_limit ?? ""}
            onChange={(e) =>
              onChange({ ...draft, daily_cost_limit: e.target.value })
            }
          />
          <Field
            required={false}
            label={t("monthlyBudget")}
            name="monthly-budget"
            value={draft.monthly_cost_limit ?? ""}
            onChange={(e) =>
              onChange({ ...draft, monthly_cost_limit: e.target.value })
            }
          />
          <Field
            type="number"
            label={t("maxOutputTokens")}
            name="max-output"
            value={draft.max_output_tokens ?? 2048}
            onChange={(e) => number("max_output_tokens", e.target.value)}
          />
          <Field
            type="number"
            label={t("maxToolIterations")}
            name="max-tools"
            value={draft.max_tool_iterations ?? 8}
            onChange={(e) => number("max_tool_iterations", e.target.value)}
          />
          <Field
            type="number"
            label={t("perChatConcurrency")}
            name="concurrency"
            value={draft.per_chat_concurrency ?? 1}
            onChange={(e) => number("per_chat_concurrency", e.target.value)}
          />
          <Field
            type="number"
            label={t("rateLimit")}
            name="agent-rate"
            value={draft.rate_limit_per_minute ?? 60}
            onChange={(e) => number("rate_limit_per_minute", e.target.value)}
          />
        </div>
      </SettingsSection>
    </>
  );
}

function AgentOperations({
  api,
  agent,
  onChanged,
}: {
  api: MessengerAPI;
  agent: Agent;
  onChanged(): void;
}) {
  const { t } = useTranslation();
  const usage = useQuery({
    queryKey: ["agent-usage", agent.id],
    queryFn: () => api.agentUsage(agent.id),
  });
  const runs = useQuery({
    queryKey: ["agent-runs", agent.id],
    queryFn: () => api.agentRuns(agent.id),
  });
  const triggers = useQuery({
    queryKey: ["agent-triggers", agent.id],
    queryFn: () => api.agentTriggers(agent.id),
  });
  const keys = useQuery({
    queryKey: ["agent-keys", agent.id],
    queryFn: () => api.agentKeys(agent.id),
  });
  const credential = useQuery({
    queryKey: ["agent-credential", agent.id],
    queryFn: () => api.agentProviderCredential(agent.id),
  });
  const [selectedRun, setSelectedRun] = useState<AgentRun | null>(null);
  const [providerKey, setProviderKey] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const [triggerType, setTriggerType] = useState("mention");
  const [triggerValue, setTriggerValue] = useState("");
  const refresh = () =>
    Promise.all([
      usage.refetch(),
      runs.refetch(),
      triggers.refetch(),
      keys.refetch(),
      credential.refetch(),
    ]);
  async function action(run: () => Promise<unknown>) {
    setError("");
    try {
      await run();
      await refresh();
      onChanged();
    } catch (cause) {
      setError(messageOf(cause));
    }
  }
  async function createTrigger() {
    const config = triggerConfig(triggerType, triggerValue, agent.chat_ids[0]);
    await action(() =>
      api.createAgentTrigger(agent.id, {
        type: triggerType as
          | "mention"
          | "command"
          | "keyword"
          | "every_message"
          | "schedule"
          | "event",
        config,
        enabled: true,
        timezone: "UTC",
        missed_runs_policy: "latest",
      }),
    );
    setTriggerValue("");
  }
  function triggerDetails(type: string, rawConfig: unknown) {
    const config = rawConfig as Record<string, unknown>;
    if (type === "command") return `/${String(config.command ?? "")}`;
    if (type === "keyword") return String(config.pattern ?? "");
    if (type === "schedule")
      return `${String(config.hour ?? 0).padStart(2, "0")}:${String(
        config.minute ?? 0,
      ).padStart(2, "0")}`;
    if (type === "event")
      return Array.isArray(config.event_types)
        ? config.event_types.join(", ")
        : t("agentTriggerEventHint");
    return type === "mention"
      ? t("agentTriggerMentionHint")
      : t("agentTriggerEveryMessageHint");
  }
  return (
    <>
      <FormError message={error} />
      <SettingsSection
        title={t("agentUsage")}
        description={t("agentUsageHint")}
        wide
      >
        <div className="agent-stat-grid">
          <span>
            <small>{t("today")}</small>
            <strong>${usage.data?.daily_cost ?? "0"}</strong>
          </span>
          <span>
            <small>{t("thisMonth")}</small>
            <strong>${usage.data?.monthly_cost ?? "0"}</strong>
          </span>
          <span>
            <small>{t("runs")}</small>
            <strong>{usage.data?.monthly_runs ?? 0}</strong>
          </span>
          <span>
            <small>{t("tokens")}</small>
            <strong>
              {(usage.data?.daily_input_tokens ?? 0) +
                (usage.data?.daily_output_tokens ?? 0)}
            </strong>
          </span>
        </div>
      </SettingsSection>
      <SettingsSection
        title={t("agentTriggers")}
        description={t("agentTriggersHint")}
        wide
      >
        <div className="agent-inline-form">
          <SelectField
            label={t("type")}
            name="trigger-type"
            value={triggerType}
            onChange={(e) => setTriggerType(e.target.value)}
          >
            {[
              "mention",
              "command",
              "keyword",
              "every_message",
              "schedule",
              "event",
            ].map((type) => (
              <option key={type} value={type}>
                {t(`agentTrigger_${type}`)}
              </option>
            ))}
          </SelectField>
          {!["mention", "every_message"].includes(triggerType) && (
            <Field
              required={false}
              label={t("configuration")}
              name="trigger-value"
              value={triggerValue}
              placeholder={
                triggerType === "schedule"
                  ? "09:00"
                  : triggerType === "event"
                    ? "member.joined"
                    : ""
              }
              onChange={(e) => setTriggerValue(e.target.value)}
            />
          )}
          <Button onClick={() => void createTrigger()}>
            <Plus />
            {t("add")}
          </Button>
        </div>
        <div className="agent-record-list">
          {(triggers.data ?? []).map((trigger) => (
            <div key={trigger.id}>
              <span>
                <strong>{t(`agentTrigger_${trigger.type}`)}</strong>
                <small>{triggerDetails(trigger.type, trigger.config)}</small>
              </span>
              <Badge tone={trigger.enabled ? "success" : "neutral"}>
                {trigger.enabled ? t("enabled") : t("disabled")}
              </Badge>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void action(() =>
                    api.updateAgentTrigger(agent.id, trigger.id, {
                      enabled: !trigger.enabled,
                    }),
                  )
                }
              >
                {trigger.enabled ? t("disable") : t("enable")}
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label={t("delete")}
                onClick={() =>
                  void action(() =>
                    api.deleteAgentTrigger(agent.id, trigger.id),
                  )
                }
              >
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>
      </SettingsSection>
      <SettingsSection
        title={t("agentRuns")}
        description={t("agentRunsHint")}
        wide
      >
        <div className="agent-record-list">
          {(runs.data?.runs ?? []).map((run) => (
            <button key={run.id} onClick={() => setSelectedRun(run)}>
              <Play />
              <span>
                <strong>
                  {t(`agentRunStatus_${run.status}`)} · {run.model}
                </strong>
                <small>
                  {run.correlation_id}
                  {run.error_code ? ` · ${run.error_code}` : ""}
                </small>
              </span>
              <time>{new Date(run.created_at).toLocaleString()}</time>
            </button>
          ))}
        </div>
        {selectedRun && (
          <div className="agent-run-detail">
            <dl>
              <div>
                <dt>{t("runStatus")}</dt>
                <dd>{t(`agentRunStatus_${selectedRun.status}`)}</dd>
              </div>
              <div>
                <dt>{t("model")}</dt>
                <dd>{selectedRun.model}</dd>
              </div>
              <div>
                <dt>{t("correlationID")}</dt>
                <dd>{selectedRun.correlation_id}</dd>
              </div>
              <div>
                <dt>{t("createdAt")}</dt>
                <dd>{new Date(selectedRun.created_at).toLocaleString()}</dd>
              </div>
              {selectedRun.error_code && (
                <div>
                  <dt>{t("errorCode")}</dt>
                  <dd>{selectedRun.error_code}</dd>
                </div>
              )}
            </dl>
            {["queued", "running"].includes(selectedRun.status) && (
              <Button
                onClick={() =>
                  void action(async () => {
                    const canceled = await api.cancelAgentRun(selectedRun.id);
                    setSelectedRun(canceled);
                  })
                }
              >
                {t("cancel")}
              </Button>
            )}
          </div>
        )}
      </SettingsSection>
      <SettingsSection
        title={t("agentCredentials")}
        description={t("agentCredentialsHint")}
        icon={<KeyRound />}
        wide
      >
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
            <Save />
            {t("save")}
          </Button>
        </div>
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
    </>
  );
}

function triggerConfig(
  type: string,
  value: string,
  chatID?: string,
): Record<string, unknown> {
  if (type === "command")
    return { command: value.replace(/^\//, ""), include_agent_messages: false };
  if (type === "keyword")
    return {
      pattern: value,
      case_sensitive: false,
      include_agent_messages: false,
    };
  if (type === "event")
    return {
      event_types: [value],
      include_agent_messages: false,
      ...(chatID ? { chat_id: chatID } : {}),
    };
  if (type === "schedule") {
    const [hour, minute] = value.split(":").map(Number);
    return {
      chat_id: chatID,
      hour: hour || 0,
      minute: minute || 0,
      days_of_week: [],
    };
  }
  return { include_agent_messages: false };
}

async function createTemplateTriggers(
  api: MessengerAPI,
  agent: Agent,
  template: Template,
  chats: Chat[],
): Promise<void> {
  const chatID = agent.chat_ids[0] ?? chats[0]?.id;
  for (const trigger of builtinTriggerRequests(template, chatID)) {
    await api.createAgentTrigger(agent.id, trigger);
  }
}
