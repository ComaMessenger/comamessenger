import { useEffect, useState } from "react";
import type { Agent, MessengerAPI } from "@comamessenger/core";
import { useTranslation } from "react-i18next";
import { messageOf } from "../../errors";
import { draftOf, emptyDraft, type Draft } from "../shared/draft";

/*
 * Editor state for the selected agent. It is owned by the platform page, not
 * by the editor view, so notices, errors and the unsaved draft survive
 * switching between agents and global tabs exactly as before the split.
 */
export function useAgentEditor({
  api,
  selected,
  refetchAgents,
  navigate,
}: {
  api: MessengerAPI;
  selected: Agent | undefined;
  refetchAgents(): Promise<unknown>;
  navigate(to: string): void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Draft>(() => ({
    ...emptyDraft(),
    display_name: t("agentTemplate_custom"),
  }));
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  useEffect(() => {
    if (selected) setDraft(draftOf(selected));
  }, [selected]);

  async function save() {
    if (!selected) return;
    setPending(true);
    setError("");
    setNotice("");
    try {
      await api.updateAgent(selected.id, {
        display_name: draft.display_name,
        handle: draft.handle,
        description: draft.description,
        enabled: draft.enabled,
        allowed_scopes: draft.allowed_scopes,
        ...(draft.llm_connection_id
          ? { llm_connection_id: draft.llm_connection_id }
          : {}),
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
      await refetchAgents();
      setNotice(t("agentSaved"));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }

  function duplicate(agent: Agent) {
    setPending(true);
    setError("");
    setNotice("");
    void api
      .duplicateAgent(agent.id, {
        display_name: `${agent.display_name} — ${t("copySuffix")}`,
        handle: `${agent.handle}_copy_${Math.random().toString(36).slice(2, 6)}`,
      })
      .then(async (created) => {
        await refetchAgents();
        navigate(`/agents/${created.id}`);
        setNotice(t("agentDuplicated"));
      })
      .catch((cause) => setError(messageOf(cause)))
      .finally(() => setPending(false));
  }

  function remove(agent: Agent) {
    setPending(true);
    void api
      .deleteAgent(agent.id)
      .then(async () => {
        setDeleteOpen(false);
        navigate("/agents");
        await refetchAgents();
      })
      .catch((cause) => setError(messageOf(cause)))
      .finally(() => setPending(false));
  }

  function resetRecipe(agent: Agent) {
    setPending(true);
    setError("");
    setNotice("");
    void api
      .resetAgentRecipe(agent.id)
      .then(async (reset) => {
        setDraft(draftOf(reset));
        await refetchAgents();
        setResetOpen(false);
        setNotice(t("templateResetDone"));
      })
      .catch((cause) => setError(messageOf(cause)))
      .finally(() => setPending(false));
  }

  return {
    draft,
    setDraft,
    error,
    setError,
    notice,
    pending,
    deleteOpen,
    setDeleteOpen,
    resetOpen,
    setResetOpen,
    save,
    duplicate,
    remove,
    resetRecipe,
  };
}

export type AgentEditorState = ReturnType<typeof useAgentEditor>;
