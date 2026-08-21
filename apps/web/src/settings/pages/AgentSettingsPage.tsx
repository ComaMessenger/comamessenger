import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  Agent,
  AgentRun,
  AgentToolConfirmation,
  AgentScope,
  Chat,
  CreateAgentRequest,
  MessengerAPI,
  User,
} from "@comamessenger/core";
import {
  Activity,
  Bot,
  Check,
  ChevronDown,
  Copy,
  FlaskConical,
  KeyRound,
  LayoutGrid,
  Play,
  Plug,
  Plus,
  Save,
  ShieldCheck,
  Trash2,
  RotateCcw,
  X,
  Zap,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { messageOf } from "../../errors";
import {
  Badge,
  Button,
  Dialog,
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
import { hasPermission } from "../registry";
import { type AgentTemplate as Template } from "../agentTemplates";

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
  "runtime:worker",
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
    recipe: template,
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
    execution_timeout_seconds: 600,
    chat_ids: [],
  };
}

function draftOf(agent: Agent): Draft {
  return {
    display_name: agent.display_name,
    handle: agent.handle,
    kind: agent.kind,
    recipe: agent.recipe,
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
    execution_timeout_seconds: agent.execution_timeout_seconds,
    chat_ids: agent.chat_ids,
  };
}

export function AgentSettingsPage({
  api,
  user,
  path,
  navigate,
}: {
  api: MessengerAPI;
  user: User;
  path: string;
  navigate(to: string): void;
}) {
  const { t } = useTranslation();
  const allowed = hasPermission(user, "agents.manage");
  const tab = path.endsWith("/sandbox")
    ? "sandbox"
    : path.endsWith("/approvals")
      ? "approvals"
      : path.endsWith("/runs")
        ? "runs"
        : path.endsWith("/connections")
          ? "connections"
          : "overview";
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
  const [draft, setDraft] = useState<Draft>(() => ({
    ...emptyDraft(),
    display_name: t("agentTemplate_custom"),
  }));
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [wizardTemplate, setWizardTemplate] = useState<Template | null>(null);
  const selected = agents.data?.find((agent) => agent.id === selectedID);
  useEffect(() => {
    if (selected) setDraft(draftOf(selected));
  }, [selected]);
  useEffect(() => {
    if (!selectedID && agents.data?.length) setSelectedID(agents.data[0]!.id);
  }, [agents.data, selectedID]);

  function chooseTemplate(value: Template) {
    setWizardTemplate(value);
    setError("");
  }

  async function save() {
    if (!selected) return;
    setPending(true);
    setError("");
    setNotice("");
    try {
      const saved = await api.updateAgent(selected.id, {
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
        execution_timeout_seconds: draft.execution_timeout_seconds,
        chat_ids: draft.chat_ids,
      });
      await agents.refetch();
      setNotice(t("agentSaved"));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="agent-platform">
      <header className="agent-platform__header">
        <div>
          <h1>{t("agentsTitle")}</h1>
          <p>{t("agentPlatformHint")}</p>
        </div>
        <nav aria-label={t("agentPlatformNavigation")}>
          {(
            [
              ["overview", "/agents", LayoutGrid],
              ["sandbox", "/agents/sandbox", FlaskConical],
              ["approvals", "/agents/approvals", ShieldCheck],
              ["runs", "/agents/runs", Activity],
              ["connections", "/agents/connections", Plug],
            ] as const
          ).map(([id, target, Icon]) => (
            <button
              key={id}
              className={tab === id ? "active" : ""}
              onClick={() => navigate(target)}
            >
              <Icon />
              <span>{t(`agentTab_${id}`)}</span>
            </button>
          ))}
        </nav>
      </header>
      <div className="agent-platform__content">
        {!allowed ? (
          <SettingsAccessDenied />
        ) : agents.isLoading || chats.isLoading ? (
          <Skeleton />
        ) : tab === "sandbox" ? (
          <AgentSandbox
            api={api}
            agents={agents.data ?? []}
            chats={chats.data ?? []}
          />
        ) : tab === "approvals" ? (
          <AgentApprovals api={api} agents={agents.data ?? []} />
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
                  <h2>{selected?.display_name ?? t("agentsEmptyTitle")}</h2>
                  <p>
                    {selected ? `@${selected.handle}` : t("agentsEmptyHint")}
                  </p>
                </div>
                {selected && tab === "overview" && (
                  <Button disabled={pending} onClick={() => void save()}>
                    <Save />
                    {pending ? t("saving") : t("save")}
                  </Button>
                )}
                {selected && tab === "overview" && (
                  <Button
                    variant="ghost"
                    disabled={pending}
                    onClick={() => {
                      setPending(true);
                      setError("");
                      setNotice("");
                      void api
                        .duplicateAgent(selected.id, {
                          display_name: `${selected.display_name} — ${t("copySuffix")}`,
                          handle: `${selected.handle}_copy_${Math.random().toString(36).slice(2, 6)}`,
                        })
                        .then(async (created) => {
                          await agents.refetch();
                          setSelectedID(created.id);
                          setNotice(t("agentDuplicated"));
                        })
                        .catch((cause) => setError(messageOf(cause)))
                        .finally(() => setPending(false));
                    }}
                  >
                    <Copy />
                    {t("duplicateAgent")}
                  </Button>
                )}
                {selected &&
                  selected.recipe !== "custom" &&
                  tab === "overview" && (
                    <Button
                      variant="ghost"
                      disabled={pending}
                      onClick={() => setResetOpen(true)}
                    >
                      <RotateCcw />
                      {t("resetTemplate")}
                    </Button>
                  )}
                {selected && tab === "overview" && (
                  <Button
                    variant="ghost"
                    disabled={pending}
                    onClick={() => setDeleteOpen(true)}
                  >
                    <Trash2 />
                    {t("deleteAgent")}
                  </Button>
                )}
              </div>
              <FormError message={error} />
              {notice && <Badge tone="success">{notice}</Badge>}
              {selected && <AgentReadiness agent={selected} />}
              {selected && tab === "overview" && (
                <AgentConfiguration
                  draft={draft}
                  chats={chats.data ?? []}
                  onChange={setDraft}
                />
              )}
              {selected && (
                <AgentOperations
                  api={api}
                  agent={selected}
                  section={tab}
                  onChanged={() => void agents.refetch()}
                />
              )}
              {selected && tab === "overview" && deleteOpen && (
                <Dialog
                  title={t("deleteAgentTitle")}
                  description={t("deleteAgentDescription", {
                    name: selected.display_name,
                  })}
                  onClose={() => setDeleteOpen(false)}
                >
                  <div className="ui-dialog__actions">
                    <Button
                      variant="ghost"
                      disabled={pending}
                      onClick={() => setDeleteOpen(false)}
                    >
                      {t("cancel")}
                    </Button>
                    <Button
                      variant="danger"
                      disabled={pending}
                      onClick={() => {
                        setPending(true);
                        void api
                          .deleteAgent(selected.id)
                          .then(async () => {
                            setDeleteOpen(false);
                            setSelectedID(null);
                            await agents.refetch();
                          })
                          .catch((cause) => setError(messageOf(cause)))
                          .finally(() => setPending(false));
                      }}
                    >
                      <Trash2 />
                      {t("deleteAgentConfirm")}
                    </Button>
                  </div>
                </Dialog>
              )}
              {selected && tab === "overview" && resetOpen && (
                <Dialog
                  title={t("resetTemplateTitle")}
                  description={t("resetTemplateDescription", {
                    name: selected.display_name,
                  })}
                  onClose={() => setResetOpen(false)}
                >
                  <div className="ui-dialog__actions">
                    <Button
                      variant="ghost"
                      disabled={pending}
                      onClick={() => setResetOpen(false)}
                    >
                      {t("cancel")}
                    </Button>
                    <Button
                      disabled={pending}
                      onClick={() => {
                        setPending(true);
                        setError("");
                        setNotice("");
                        void api
                          .resetAgentRecipe(selected.id)
                          .then(async (reset) => {
                            setDraft(draftOf(reset));
                            await agents.refetch();
                            setResetOpen(false);
                            setNotice(t("templateResetDone"));
                          })
                          .catch((cause) => setError(messageOf(cause)))
                          .finally(() => setPending(false));
                      }}
                    >
                      <RotateCcw />
                      {pending ? t("saving") : t("resetTemplateConfirm")}
                    </Button>
                  </div>
                </Dialog>
              )}
            </div>
          </div>
        )}
      </div>
      {wizardTemplate && (
        <AgentCreationWizard
          api={api}
          template={wizardTemplate}
          chats={chats.data ?? []}
          onClose={() => setWizardTemplate(null)}
          onCreated={async (created) => {
            setWizardTemplate(null);
            await agents.refetch();
            setSelectedID(created.id);
          }}
        />
      )}
    </section>
  );
}

function AgentCreationWizard({
  api,
  template,
  chats,
  onClose,
  onCreated,
}: {
  api: MessengerAPI;
  template: Template;
  chats: Chat[];
  onClose(): void;
  onCreated(agent: Agent): Promise<void>;
}) {
  const { t } = useTranslation();
  const [step, setStep] = useState(1);
  const [draft, setDraft] = useState<Draft>(() => ({
    ...emptyDraft(template),
    display_name: t(`agentTemplate_${template}`),
    description:
      template === "custom" ? "" : t(`agentTemplateDescription_${template}`),
  }));
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  function selectTemplate(value: Template) {
    const next = emptyDraft(value);
    setDraft({
      ...next,
      display_name: t(`agentTemplate_${value}`),
      description:
        value === "custom" ? "" : t(`agentTemplateDescription_${value}`),
    });
  }
  function next() {
    setError("");
    if (step === 1 && (!draft.display_name.trim() || !draft.handle.trim())) {
      setError(t("agentWizardIdentityRequired"));
      return;
    }
    if (step === 2 && draft.chat_ids.length === 0) {
      setError(t("agentTemplateChatRequired"));
      return;
    }
    setStep((current) => Math.min(3, current + 1));
  }
  async function create() {
    setPending(true);
    setError("");
    try {
      await onCreated(await api.createAgent({ ...draft, enabled: false }));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog
      title={t("agentWizardTitle")}
      description={t("agentWizardStep", { current: step, total: 3 })}
      onClose={onClose}
    >
      <div className="agent-wizard">
        <div className="agent-wizard__progress" aria-hidden="true">
          {[1, 2, 3].map((item) => (
            <span key={item} className={item <= step ? "active" : ""} />
          ))}
        </div>
        {step === 1 && (
          <div className="agent-wizard__step">
            <div>
              <h3>{t("agentWizardPurpose")}</h3>
              <p>{t("agentWizardPurposeHint")}</p>
            </div>
            <div className="agent-wizard__templates">
              {(["summarizer", "qa", "onboarding", "custom"] as const).map(
                (item) => (
                  <button
                    key={item}
                    className={draft.recipe === item ? "active" : ""}
                    onClick={() => selectTemplate(item)}
                  >
                    <Zap />
                    <strong>{t(`agentTemplate_${item}`)}</strong>
                    <small>{t(`agentTemplateShort_${item}`)}</small>
                  </button>
                ),
              )}
            </div>
            <div className="settings-form-grid">
              <Field
                label={t("displayName")}
                name="wizard-agent-name"
                value={draft.display_name}
                onChange={(event) =>
                  setDraft({ ...draft, display_name: event.target.value })
                }
              />
              <Field
                label={t("handle")}
                name="wizard-agent-handle"
                value={draft.handle}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    handle: event.target.value.toLowerCase(),
                  })
                }
              />
            </div>
          </div>
        )}
        {step === 2 && (
          <div className="agent-wizard__step">
            <div>
              <h3>{t("agentWizardAccess")}</h3>
              <p>{t("agentWizardAccessHint")}</p>
            </div>
            <div className="agent-wizard__chats">
              {chats.map((chat) => (
                <label key={chat.id}>
                  <input
                    type="checkbox"
                    checked={draft.chat_ids.includes(chat.id)}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        chat_ids: event.target.checked
                          ? [...draft.chat_ids, chat.id]
                          : draft.chat_ids.filter((id) => id !== chat.id),
                      })
                    }
                  />
                  <span>{chatName(chat)}</span>
                </label>
              ))}
            </div>
          </div>
        )}
        {step === 3 && (
          <div className="agent-wizard__step">
            <div>
              <h3>{t("agentWizardLaunch")}</h3>
              <p>{t("agentWizardLaunchHint")}</p>
            </div>
            <dl className="agent-wizard__summary">
              <div>
                <dt>{t("agentWizardTask")}</dt>
                <dd>{t(`agentTemplate_${draft.recipe}`)}</dd>
              </div>
              <div>
                <dt>{t("agentWizardWhere")}</dt>
                <dd>
                  {chats
                    .filter((chat) => draft.chat_ids.includes(chat.id))
                    .map(chatName)
                    .join(", ")}
                </dd>
              </div>
              <div>
                <dt>{t("agentWizardWhen")}</dt>
                <dd>{t(`agentRecipeLaunch_${draft.recipe}`)}</dd>
              </div>
            </dl>
            <div className="agent-wizard__notice">
              <ShieldCheck />
              <span>{t("agentWizardSafeStart")}</span>
            </div>
          </div>
        )}
        <FormError message={error} />
        <div className="ui-dialog__actions">
          {step > 1 && (
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() => setStep(step - 1)}
            >
              {t("back")}
            </Button>
          )}
          <Button variant="ghost" disabled={pending} onClick={onClose}>
            {t("cancel")}
          </Button>
          {step < 3 ? (
            <Button onClick={next}>{t("continue")}</Button>
          ) : (
            <Button disabled={pending} onClick={() => void create()}>
              <Plus />
              {pending ? t("saving") : t("createAgent")}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function chatName(chat: Chat): string {
  return chat.name || chat.direct_peer?.display_name || chat.id;
}

function AgentReadiness({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  return (
    <div className="agent-readiness">
      <span>
        <strong>{t("agentReadiness")}</strong>
        <small>{t(`agentReadinessState_${agent.readiness.state}`)}</small>
      </span>
      <Badge tone={agent.readiness.ready ? "success" : "neutral"}>
        {agent.readiness.ready ? t("ready") : t("needsSetup")}
      </Badge>
      {agent.readiness.blockers.length > 0 && (
        <ul>
          {agent.readiness.blockers.map((blocker) => (
            <li key={blocker}>{t(`agentReadiness_${blocker}`)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AgentSandbox({
  api,
  agents,
  chats,
}: {
  api: MessengerAPI;
  agents: Agent[];
  chats: Chat[];
}) {
  const { t } = useTranslation();
  const [agentID, setAgentID] = useState(agents[0]?.id ?? "");
  const [chatID, setChatID] = useState(
    agents[0]?.chat_ids[0] ?? chats[0]?.id ?? "",
  );
  const [prompt, setPrompt] = useState("");
  const [run, setRun] = useState<AgentRun | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  async function invoke() {
    setPending(true);
    setError("");
    try {
      const created = await api.invokeAgent(agentID, {
        chat_id: chatID,
        client_run_id: crypto.randomUUID(),
        chain_depth: 0,
        timeout_seconds: 600,
        max_attempts: 1,
        input: { prompt, sandbox: true, publish: false },
      });
      setRun(created);
      for (let attempt = 0; attempt < 60; attempt++) {
        await new Promise((resolve) => window.setTimeout(resolve, 1_000));
        const current = await api.agentRun(created.id);
        setRun(current);
        if (!["queued", "running"].includes(current.status)) break;
      }
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="agent-sandbox">
      <div className="agent-sandbox__intro">
        <FlaskConical />
        <div>
          <h2>{t("agentSandboxTitle")}</h2>
          <p>{t("agentSandboxHint")}</p>
        </div>
      </div>
      <div className="agent-sandbox__controls">
        <SelectField
          label={t("agent")}
          name="sandbox-agent"
          value={agentID}
          onChange={(event) => {
            const id = event.target.value;
            setAgentID(id);
            const selected = agents.find((item) => item.id === id);
            if (selected?.chat_ids[0]) setChatID(selected.chat_ids[0]);
          }}
        >
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.display_name}
            </option>
          ))}
        </SelectField>
        <SelectField
          label={t("chat")}
          name="sandbox-chat"
          value={chatID}
          onChange={(event) => setChatID(event.target.value)}
        >
          {chats.map((chat) => (
            <option key={chat.id} value={chat.id}>
              {chat.name || chat.direct_peer?.display_name || chat.id}
            </option>
          ))}
        </SelectField>
      </div>
      <TextareaField
        label={t("sandboxPrompt")}
        name="sandbox-prompt"
        rows={8}
        value={prompt}
        placeholder={t("sandboxPromptPlaceholder")}
        onChange={(event) => setPrompt(event.target.value)}
      />
      <FormError message={error} />
      <div className="agent-sandbox__actions">
        <Button
          disabled={pending || !agentID || !chatID || !prompt.trim()}
          onClick={() => void invoke()}
        >
          <Play />
          {pending ? t("agentSandboxStarting") : t("agentSandboxRun")}
        </Button>
        {run && (
          <span>
            <Badge tone="neutral">{t(`agentRunStatus_${run.status}`)}</Badge>
            <small>{run.correlation_id}</small>
          </span>
        )}
      </div>
      {run && typeof run.result_summary.preview === "string" && (
        <div className="agent-sandbox__preview">
          <strong>{t("agentSandboxResult")}</strong>
          <p>{run.result_summary.preview}</p>
        </div>
      )}
    </div>
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
      | "provider_rate_limit_per_minute"
      | "execution_timeout_seconds",
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
              <span>{chatName(chat)}</span>
            </label>
          ))}
        </div>
      </SettingsSection>
      <details className="agent-advanced">
        <summary>
          <span>
            <strong>{t("agentAdvanced")}</strong>
            <small>{t("agentAdvancedHint")}</small>
          </span>
          <ChevronDown />
        </summary>
        <div className="agent-advanced__content">
          <SettingsSection
            title={t("agentProviderSettings")}
            description={t("agentProviderSettingsHint")}
            wide
          >
            <div className="settings-form-grid">
              <SelectField
                label={t("provider")}
                name="agent-provider"
                value={draft.provider}
                onChange={(e) =>
                  onChange({ ...draft, provider: e.target.value })
                }
              >
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="openai-compatible">
                  {t("openAICompatible")}
                </option>
              </SelectField>
              <Field
                label={t("model")}
                name="agent-model"
                value={draft.model ?? ""}
                onChange={(e) => onChange({ ...draft, model: e.target.value })}
              />
              {draft.provider === "openai-compatible" && (
                <Field
                  label={t("providerEndpoint")}
                  name="agent-provider-endpoint"
                  value={draft.endpoint_url ?? ""}
                  placeholder="https://llm.example.com/v1"
                  onChange={(e) =>
                    onChange({ ...draft, endpoint_url: e.target.value })
                  }
                />
              )}
            </div>
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
                          : draft.allowed_scopes.filter(
                              (item) => item !== scope,
                            ),
                      })
                    }
                  />
                  <span>{t(`agentScope_${scope.replace(":", "_")}`)}</span>
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
                onChange={(e) =>
                  number("rate_limit_per_minute", e.target.value)
                }
              />
              <Field
                type="number"
                label={t("executionTimeout")}
                name="execution-timeout"
                value={draft.execution_timeout_seconds ?? 600}
                onChange={(e) =>
                  number("execution_timeout_seconds", e.target.value)
                }
              />
            </div>
          </SettingsSection>
        </div>
      </details>
    </>
  );
}

function AgentApprovals({
  api,
  agents,
}: {
  api: MessengerAPI;
  agents: Agent[];
}) {
  const { t } = useTranslation();
  const confirmations = useQuery({
    queryKey: ["agent-tool-confirmations"],
    queryFn: () => api.agentToolConfirmations("pending"),
    refetchInterval: 5_000,
  });
  const [error, setError] = useState("");
  async function decide(confirmation: AgentToolConfirmation, approve: boolean) {
    setError("");
    try {
      if (approve) await api.approveAgentToolConfirmation(confirmation.id);
      else await api.denyAgentToolConfirmation(confirmation.id);
      await confirmations.refetch();
    } catch (cause) {
      setError(messageOf(cause));
    }
  }
  return (
    <div className="agent-approvals">
      <header>
        <div>
          <h2>{t("agentApprovalsTitle")}</h2>
          <p>{t("agentApprovalsHint")}</p>
        </div>
        <Badge>{confirmations.data?.length ?? 0}</Badge>
      </header>
      {error && <FormError message={error} />}
      {confirmations.isLoading ? (
        <Skeleton />
      ) : confirmations.data?.length ? (
        <div className="agent-approval-list">
          {confirmations.data.map((confirmation) => (
            <article key={confirmation.id}>
              <div>
                <strong>{t(`agentTool_${confirmation.tool_name}`)}</strong>
                <small>
                  {agents.find((item) => item.id === confirmation.agent_id)
                    ?.display_name ?? confirmation.agent_id}
                  {" · "}
                  {new Date(confirmation.requested_at).toLocaleString()}
                </small>
              </div>
              <pre>{JSON.stringify(confirmation.arguments, null, 2)}</pre>
              <footer>
                <Button
                  variant="secondary"
                  onClick={() => void decide(confirmation, false)}
                >
                  <X />
                  {t("deny")}
                </Button>
                <Button onClick={() => void decide(confirmation, true)}>
                  <Check />
                  {t("approve")}
                </Button>
              </footer>
            </article>
          ))}
        </div>
      ) : (
        <p className="agent-empty-state">{t("agentApprovalsEmpty")}</p>
      )}
    </div>
  );
}

function AgentOperations({
  api,
  agent,
  section,
  onChanged,
}: {
  api: MessengerAPI;
  agent: Agent;
  section: "overview" | "runs" | "connections";
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
      {section === "overview" && (
        <>
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
                    <small>
                      {triggerDetails(trigger.type, trigger.config)}
                    </small>
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
        </>
      )}
      {section === "runs" && (
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
                    {run.error_code
                      ? ` · ${agentRunErrorText(t, run.error_code)}`
                      : ""}
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
                    <dd>{agentRunErrorText(t, selectedRun.error_code)}</dd>
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
      )}
      {section === "connections" && (
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
                      .map((scope) =>
                        t(`agentScope_${scope.replace(":", "_")}`),
                      )
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
                      allowed_scopes: [
                        ...agent.allowed_scopes,
                        "runtime:worker",
                      ],
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
      )}
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

function agentRunErrorText(
  t: ReturnType<typeof useTranslation>["t"],
  code: string,
): string {
  const known = new Set([
    "provider_credential_missing",
    "external_data_sharing_required",
    "budget_exceeded",
    "agent_provider_rate_limited",
    "provider_retryable",
    "provider_output_truncated",
    "tool_iteration_limit",
    "empty_provider_output",
    "run_timeout",
    "lease_expired",
    "run_canceled",
  ]);
  return known.has(code)
    ? t(`agentRunError_${code}`)
    : t("agentRunError_unknown");
}
