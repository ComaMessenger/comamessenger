import type { Agent, MessengerAPI } from "@comamessenger/core";
import { FormError } from "../../ui";
import { AgentCredentialsSection } from "./AgentCredentialsSection";
import { AgentRunsSection } from "./AgentRunsSection";
import { AgentTriggersSection } from "./AgentTriggersSection";
import { AgentUsageSection } from "./AgentUsageSection";
import {
  useAgentOperations,
  type AgentOperationsSection,
} from "./useAgentOperations";

export function AgentOperations({
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
  const operations = useAgentOperations({
    api,
    agent,
    canBuild,
    section,
    onChanged,
  });
  return (
    <>
      <FormError message={operations.error} />
      {section === "overview" && (
        <AgentUsageSection usage={operations.usage.data} />
      )}
      {section === "automations" && (
        <AgentTriggersSection
          api={api}
          agent={agent}
          canBuild={canBuild}
          operations={operations}
        />
      )}
      {section === "activity" && (
        <AgentRunsSection api={api} operations={operations} />
      )}
      {section === "settings" && (
        <AgentCredentialsSection
          api={api}
          agent={agent}
          operations={operations}
        />
      )}
    </>
  );
}
