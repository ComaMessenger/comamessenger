import { useState } from "react";
import type { Agent, AgentRun, Chat, MessengerAPI } from "@comamessenger/core";
import { FlaskConical, Play } from "lucide-react";
import { useTranslation } from "react-i18next";
import { messageOf } from "../../errors";
import { Badge, Button, FormError, SelectField, TextareaField } from "../../ui";

export function AgentSandbox({
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
        dry_run: true,
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
      {run && (
        <dl className="agent-sandbox__trace">
          <div>
            <dt>{t("agentTestVersion")}</dt>
            <dd>v{run.agent_version ?? "—"}</dd>
          </div>
          <div>
            <dt>{t("agentTestModel")}</dt>
            <dd>
              {run.provider} · {run.model}
            </dd>
          </div>
          <div>
            <dt>{t("agentTestTokens")}</dt>
            <dd>
              {run.input_tokens} / {run.output_tokens}
            </dd>
          </div>
          <div>
            <dt>{t("agentTestCost")}</dt>
            <dd>
              {run.cost} {run.currency}
            </dd>
          </div>
          <div>
            <dt>{t("agentTestWrites")}</dt>
            <dd>{t("agentTestWritesBlocked")}</dd>
          </div>
        </dl>
      )}
    </div>
  );
}
