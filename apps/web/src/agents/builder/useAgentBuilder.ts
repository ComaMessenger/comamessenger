import { useEffect, useRef, useState } from "react";
import type {
  Agent,
  AgentLlmConnection,
  AgentTrigger,
  MessengerAPI,
} from "@comamessenger/core";
import { APIError } from "@comamessenger/core";
import { useTranslation } from "react-i18next";
import { messageOf } from "../../errors";
import type { BuilderAnchor } from "../routes";
import { draftChatIDs, draftOf, updateOf, type Draft } from "../shared/draft";

const snapshot = (draft: Draft) => JSON.stringify(updateOf(draft));

export type PublishBlocker = { key: string; anchor: BuilderAnchor };

/**
 * What stops publishing, computed from the local draft so the reason is
 * visible before saving. Server-only facts (keys of external agents, a legacy
 * provider key) come from the saved readiness.
 */
export function publishBlockers(
  agent: Agent,
  draft: Draft,
  triggers: AgentTrigger[] | undefined,
  connections: AgentLlmConnection[],
): PublishBlocker[] {
  const result: PublishBlocker[] = [];
  const serverBlockers = new Set(agent.readiness.blockers);
  if (draftChatIDs(draft).length === 0)
    result.push({ key: "chat_required", anchor: "places" });
  if (agent.kind === "external" && serverBlockers.has("runtime_key_required"))
    result.push({ key: "runtime_key_required", anchor: "advanced" });
  if (agent.kind === "builtin") {
    const connection = connections.find(
      (item) => item.id === draft.llm_connection_id,
    );
    if (draft.llm_connection_id && (!connection || !connection.enabled))
      result.push({ key: "llm_connection_unavailable", anchor: "model" });
    else if (
      !draft.llm_connection_id &&
      (serverBlockers.has("llm_connection_required") ||
        serverBlockers.has("provider_credential_required"))
    )
      result.push({ key: "llm_connection_required", anchor: "model" });
    if (!draft.model)
      result.push({ key: "provider_model_required", anchor: "advanced" });
    if (!draft.external_data_sharing_approved)
      result.push({ key: "external_data_approval_required", anchor: "model" });
  }
  if (
    agent.recipe !== "custom" &&
    triggers !== undefined &&
    !triggers.some((trigger) => trigger.enabled)
  )
    result.push({ key: "trigger_required", anchor: "triggers" });
  return result;
}

/*
 * Builder state of one agent. The page mounts it under `key={agent.id}`, so
 * nothing typed for one agent (draft, secrets, forms) survives into another.
 */
export function useAgentBuilder({
  api,
  agent,
  refetchAgents,
}: {
  api: MessengerAPI;
  agent: Agent;
  refetchAgents(): Promise<unknown>;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Draft>(() => draftOf(agent));
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState("");
  const saved = useRef(snapshot(draftOf(agent)));
  const dirty = snapshot(draft) !== saved.current;

  // Adopt a newer server copy unless the person has unsaved edits.
  useEffect(() => {
    const incoming = draftOf(agent);
    const previous = saved.current;
    saved.current = snapshot(incoming);
    setDraft((current) =>
      snapshot(current) === previous ? incoming : current,
    );
  }, [agent]);

  async function run(
    action: string,
    work: () => Promise<unknown>,
    success?: string,
  ): Promise<boolean> {
    setPending(action);
    setError("");
    setNotice("");
    try {
      await work();
      if (success) setNotice(t(success));
      return true;
    } catch (cause) {
      // Loosened confirmations are asked about in a dialog, not as an error.
      if (!(cause instanceof APIError && cause.code === "agent_confirmation_loosened"))
        setError(messageOf(cause));
      return false;
    } finally {
      setPending("");
    }
  }

  // The saved copy is adopted only after the agents list is fresh, so the
  // builder never shows the old «nothing to publish» state for a draft that
  // was just saved.
  async function persist() {
    const updated = await api.updateAgent(agent.id, updateOf(draft));
    await refetchAgents();
    saved.current = snapshot(draftOf(updated));
    setDraft(draftOf(updated));
  }
  // Actions the publish would let run without a person; the builder asks the
  // publisher to confirm them before publishing again.
  const [loosened, setLoosened] = useState<string[]>([]);
  async function publishWith(acknowledge: boolean) {
    if (dirty) await persist();
    try {
      await api.publishAgent(agent.id, acknowledge ? { acknowledge_loosened: true } : {});
    } catch (cause) {
      if (cause instanceof APIError && cause.code === "agent_confirmation_loosened") {
        const listed = cause.details.loosened;
        setLoosened(Array.isArray(listed) ? listed.map(String) : []);
        throw cause;
      }
      throw cause;
    }
    setLoosened([]);
    await refetchAgents();
  }

  return {
    draft,
    setDraft,
    dirty,
    error,
    setError,
    notice,
    setNotice,
    pending,
    save: () => run("save", persist, "agentDraftSaved"),
    /** Saves pending edits first; used before a check and a publish. */
    saveIfDirty: () => (dirty ? run("save", persist) : Promise.resolve(true)),
    loosened,
    cancelLoosened: () => setLoosened([]),
    publish: (acknowledge = false) =>
      run("publish", () => publishWith(acknowledge), "agentPublishedNotice"),
    pause: () =>
      run(
        "pause",
        async () => {
          await api.pauseAgent(agent.id);
          await refetchAgents();
        },
        "agentPausedNotice",
      ),
    resume: () =>
      run(
        "resume",
        async () => {
          await api.resumeAgent(agent.id);
          await refetchAgents();
        },
        "agentResumedNotice",
      ),
    rollback: (versionID: string) =>
      run(
        "rollback",
        async () => {
          await api.rollbackAgent(agent.id, versionID);
          await refetchAgents();
        },
        "agentRollbackNotice",
      ),
    discard: () => setDraft(draftOf(agent)),
  };
}

export type AgentBuilderState = ReturnType<typeof useAgentBuilder>;
