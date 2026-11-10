import type { AgentScope } from "@comamessenger/core";

/*
 * The builder never asks for scopes. Blocks «What it knows» and «What it can
 * do» are switches in plain language; scopes are derived from them and only
 * shown in advanced settings.
 *
 * Confirmation modes mirror the server: every write tool waits for a human
 * decision, except the interactive tools (cards, collections, follow-ups),
 * which are bounded by their own scopes and limits (docs/protocols/agents-v1.md).
 * The answer to the run itself is published without a tool and never waits.
 */

export type KnowledgeSource = "search" | "files" | "members";
export type Skill = "messages" | "reactions" | "cards" | "followups" | "memory";
export type SkillMode = "self" | "confirm" | "mixed";

export const knowledgeSources: KnowledgeSource[] = [
  "search",
  "files",
  "members",
];
export const skills: Skill[] = [
  "messages",
  "cards",
  "followups",
  "reactions",
  "memory",
];

export const skillMode: Record<Skill, SkillMode> = {
  messages: "mixed",
  reactions: "confirm",
  cards: "self",
  followups: "self",
  memory: "mixed",
};

const sourceScopes: Record<KnowledgeSource, AgentScope[]> = {
  search: ["search:read"],
  files: ["files:read"],
  members: ["members:read"],
};

const skillScopes: Record<Skill, AgentScope[]> = {
  messages: ["messages:write"],
  reactions: ["reactions:write"],
  cards: ["messages:interactive"],
  followups: ["followups:write"],
  memory: ["memory:read", "memory:write"],
};

/** Scopes the builder does not derive and therefore keeps as they are. */
const preservedScopes: AgentScope[] = ["chats:read", "runtime:worker"];

export type Capabilities = {
  sources: KnowledgeSource[];
  skills: Skill[];
};

export function capabilitiesOf(scopes: readonly AgentScope[]): Capabilities {
  const has = (required: AgentScope[]) =>
    required.every((scope) => scopes.includes(scope));
  return {
    sources: knowledgeSources.filter((source) => has(sourceScopes[source])),
    skills: skills.filter((skill) => has(skillScopes[skill])),
  };
}

/**
 * Derives the agent scopes from the builder blocks. Reading the history of
 * the agent chats and running are always required by the built-in runtime;
 * knowledge access follows the bound collections.
 */
export function scopesFor({
  capabilities,
  hasKnowledge,
  current,
}: {
  capabilities: Capabilities;
  hasKnowledge: boolean;
  current: readonly AgentScope[];
}): AgentScope[] {
  const result = new Set<AgentScope>(["messages:read", "runtime:execute"]);
  for (const source of capabilities.sources)
    sourceScopes[source].forEach((scope) => result.add(scope));
  for (const skill of capabilities.skills)
    skillScopes[skill].forEach((scope) => result.add(scope));
  if (hasKnowledge) result.add("knowledge:read");
  // Slot tables are read from bound collections; a recipe that reads them
  // keeps the scope while a collection stays bound.
  if (hasKnowledge && current.includes("tables:read")) result.add("tables:read");
  for (const scope of preservedScopes)
    if (current.includes(scope)) result.add(scope);
  return orderedScopes.filter((scope) => result.has(scope));
}

export const orderedScopes: AgentScope[] = [
  "chats:read",
  "messages:read",
  "messages:write",
  "messages:interactive",
  "reactions:write",
  "files:read",
  "search:read",
  "members:read",
  "knowledge:read",
  "tables:read",
  "memory:read",
  "memory:write",
  "followups:write",
  "runtime:execute",
  "runtime:worker",
];
