import type { AgentAccess } from "@comamessenger/core";

/*
 * Screens of package B (Architect and agent builder) that this section links
 * to. They are not in the app yet: until a route lands, its entry points stay
 * hidden instead of opening an empty screen. B switches one on here, in one
 * line, together with the route file.
 */
export const builderRoutes = {
  /** `/agents/new` (optionally `?recipe=<id>`): create an agent. */
  create: false,
  /** `/agents/<id>/edit`: change an agent in the builder. */
  edit: false,
} as const;

export function canCreateAgent(access: AgentAccess): boolean {
  return builderRoutes.create && access.canBuild;
}

export function canEditAgent(access: AgentAccess): boolean {
  return builderRoutes.edit && access.canBuild;
}

export const agentHref = {
  agent: (id: string) => `/agents/${encodeURIComponent(id)}`,
  check: (id: string) => `/agents/${encodeURIComponent(id)}/check`,
  edit: (id: string) => `/agents/${encodeURIComponent(id)}/edit`,
  create: (recipe?: string) =>
    recipe ? `/agents/new?recipe=${encodeURIComponent(recipe)}` : "/agents/new",
  approvals: "/agents/approvals",
  activity: (agentID?: string) =>
    agentID
      ? `/agents/activity?agent=${encodeURIComponent(agentID)}`
      : "/agents/activity",
  run: (id: string) => `/agents/runs/${encodeURIComponent(id)}`,
};
