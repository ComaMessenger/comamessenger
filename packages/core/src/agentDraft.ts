import type {
  Agent,
  AgentRecipe,
  CreateAgentRequest,
} from "./types";

/** The editable copy of an agent in the builder (a create request). */
export type AgentDraft = CreateAgentRequest;

const customScopes: AgentDraft["allowed_scopes"] = [
  "messages:read",
  "messages:write",
  "search:read",
  "files:read",
  "memory:read",
  "memory:write",
  "runtime:execute",
];

/**
 * A new agent. A recipe agent carries no instructions of its own: Core fills
 * them in from its catalog in `locale`, so recipe texts live only on the
 * server.
 */
export function emptyDraft(recipe?: AgentRecipe, locale = "en"): AgentDraft {
  const suffix = Math.random().toString(36).slice(2, 7);
  return {
    display_name: recipe?.name ?? "New agent",
    handle: `${recipe ? recipe.id : "agent"}_${suffix}`,
    kind: "builtin",
    recipe: recipe?.id ?? "custom",
    description: "",
    locale,
    enabled: false,
    allowed_scopes: recipe ? [...recipe.scopes] : customScopes,
    llm_connection_id: "",
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
    knowledge_collection_ids: [],
  };
}

export function draftOf(agent: Agent): AgentDraft {
  return {
    display_name: agent.display_name,
    handle: agent.handle,
    kind: agent.kind,
    recipe: agent.recipe,
    description: agent.description,
    enabled: agent.enabled,
    allowed_scopes: agent.allowed_scopes,
    llm_connection_id: agent.llm_connection_id ?? "",
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
    read_chat_ids: agent.read_chat_ids ?? agent.chat_ids,
    write_chat_ids: agent.write_chat_ids ?? agent.chat_ids,
    knowledge_collection_ids: agent.knowledge_collection_ids ?? [],
    mcp_bindings: agent.mcp_bindings ?? [],
    tone: agent.tone ?? "",
    confirmation_policy: agent.confirmation_policy ?? {},
  };
}

/** Every chat of the draft: where it reads and where it writes. */
export function draftChatIDs(draft: AgentDraft): string[] {
  if (!draft.read_chat_ids && !draft.write_chat_ids) return draft.chat_ids;
  return [
    ...new Set([...(draft.read_chat_ids ?? []), ...(draft.write_chat_ids ?? [])]),
  ].sort();
}

/** The request body of a draft save; the server keeps unspecified fields. */
export function updateOf(draft: AgentDraft) {
  return {
    display_name: draft.display_name,
    handle: draft.handle,
    description: draft.description,
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
    chat_ids: draftChatIDs(draft),
    ...(draft.read_chat_ids ? { read_chat_ids: draft.read_chat_ids } : {}),
    ...(draft.write_chat_ids ? { write_chat_ids: draft.write_chat_ids } : {}),
    knowledge_collection_ids: draft.knowledge_collection_ids ?? [],
    ...(draft.mcp_bindings ? { mcp_bindings: draft.mcp_bindings } : {}),
    ...(draft.tone !== undefined ? { tone: draft.tone } : {}),
    ...(draft.confirmation_policy
      ? { confirmation_policy: draft.confirmation_policy }
      : {}),
  };
}
