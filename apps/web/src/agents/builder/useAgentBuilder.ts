import { useEffect, useRef, useState } from "react";
import type { Agent, MessengerAPI } from "@comamessenger/core";
import { APIError, loosenedOf } from "@comamessenger/core";
import { useTranslation } from "react-i18next";
import { messageOf } from "../../errors";
import { draftOf, updateOf, type Draft } from "../shared/draft";

const snapshot = (draft: Draft) => JSON.stringify(updateOf(draft));

export { publishBlockers, type PublishBlocker } from "@comamessenger/core";

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
      const loosened = loosenedOf(cause);
      if (loosened) setLoosened(loosened);
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
