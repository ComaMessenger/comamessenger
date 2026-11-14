import type { AgentAccess } from "@comamessenger/core";
import { agentBuilderPaths } from "./builder/data";

/* Building and changing agents (the builder and the Architect) takes agents.build. */
export function canCreateAgent(access: AgentAccess): boolean {
  return access.canBuild;
}

export function canEditAgent(access: AgentAccess): boolean {
  return access.canBuild;
}

export const agentHref = {
  agent: (id: string) => `/agents/${encodeURIComponent(id)}`,
  check: (id: string) => `/agents/${encodeURIComponent(id)}/check`,
  /** The builder: an agent's page with its steps. */
  edit: (id: string) => agentBuilderPaths.edit(id),
  /** Three ways to create; with a role — straight to its template. */
  create: (recipe?: string) =>
    recipe ? agentBuilderPaths.template(recipe) : agentBuilderPaths.create,
  approvals: "/agents/approvals",
  activity: (agentID?: string) =>
    agentID
      ? `/agents/activity?agent=${encodeURIComponent(agentID)}`
      : "/agents/activity",
  run: (id: string) => `/agents/runs/${encodeURIComponent(id)}`,
};
