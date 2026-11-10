import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Agent, AgentRun, MessengerAPI } from "@comamessenger/core";
import { messageOf } from "../../errors";

export type AgentOperationsSection =
  | "overview"
  | "automations"
  | "activity"
  | "settings";

/*
 * Queries and local state shared by the operational sections of an agent.
 * They live together on purpose: every action refetches all of them, and the
 * form state survives switching between these sections, exactly as before the
 * module split.
 */
export function useAgentOperations({
  api,
  agent,
  canBuild,
  section,
  onChanged,
}: {
  api: MessengerAPI;
  agent: Agent;
  canBuild: boolean;
  section: AgentOperationsSection;
  onChanged(): void;
}) {
  const usage = useQuery({
    queryKey: ["agent-usage", agent.id],
    queryFn: () => api.agentUsage(agent.id),
    enabled: section === "overview",
  });
  const runs = useQuery({
    queryKey: ["agent-runs", agent.id],
    queryFn: () => api.agentRuns(agent.id),
    enabled: section === "activity",
  });
  const triggers = useQuery({
    queryKey: ["agent-triggers", agent.id],
    queryFn: () => api.agentTriggers(agent.id),
    enabled: section === "automations",
  });
  const keys = useQuery({
    queryKey: ["agent-keys", agent.id],
    queryFn: () => api.agentKeys(agent.id),
    enabled: canBuild && section === "settings",
  });
  const credential = useQuery({
    queryKey: ["agent-credential", agent.id],
    queryFn: () => api.agentProviderCredential(agent.id),
    enabled: canBuild && section === "settings" && !agent.llm_connection_id,
  });
  const [selectedRun, setSelectedRun] = useState<AgentRun | null>(null);
  const [providerKey, setProviderKey] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const [triggerType, setTriggerType] = useState("mention");
  const [triggerValue, setTriggerValue] = useState("");
  const refresh = () => {
    const requests: Promise<unknown>[] = [
      usage.refetch(),
      runs.refetch(),
      triggers.refetch(),
      keys.refetch(),
    ];
    if (!agent.llm_connection_id) requests.push(credential.refetch());
    return Promise.all(requests);
  };
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
  return {
    usage,
    runs,
    triggers,
    keys,
    credential,
    selectedRun,
    setSelectedRun,
    providerKey,
    setProviderKey,
    secret,
    setSecret,
    error,
    triggerType,
    setTriggerType,
    triggerValue,
    setTriggerValue,
    action,
  };
}

export type AgentOperationsState = ReturnType<typeof useAgentOperations>;
