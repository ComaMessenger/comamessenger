import type {
  Agent,
  AgentScope,
  CreateAgentRequest,
} from "@comamessenger/core";
import type { AgentTemplate as Template } from "../agentTemplates";

export const agentScopes: AgentScope[] = [
  "chats:read",
  "messages:read",
  "messages:write",
  "reactions:write",
  "files:read",
  "search:read",
  "members:read",
  "memory:read",
  "memory:write",
  "runtime:execute",
  "runtime:worker",
];

export type Draft = CreateAgentRequest;

/*
 * Client-side copy of the built-in recipe prompts. The server keeps its own
 * defaults in `recipeDefaults` (core/internal/agent) and exposes no endpoint to
 * read them, so this duplicate stays until the API publishes recipes.
 */
export const templateDescriptions: Record<Template, string> = {
  custom: "",
  summarizer:
    "You are the workspace Summarizer. On /summarize, summarize the current chat or thread with decisions, open questions and action items. For scheduled runs, produce a concise digest. Use message IDs as citations and never invent facts.",
  qa: "You answer questions from accessible workspace history and extracted files. Search before answering, cite the exact message or file identifiers used, distinguish evidence from inference, and say when the answer is not available.",
  onboarding:
    "You are the onboarding guide. Greet new members in the configured chat, explain the workspace using only accessible history and files, link to source message IDs, and answer follow-up questions without exposing private chats.",
};

export function emptyDraft(template: Template = "custom"): Draft {
  const suffix = Math.random().toString(36).slice(2, 7);
  return {
    display_name:
      template === "summarizer"
        ? "Summarizer"
        : template === "qa"
          ? "Workspace Q&A"
          : template === "onboarding"
            ? "Onboarding"
            : "New agent",
    handle: `${template === "custom" ? "agent" : template}_${suffix}`,
    kind: "builtin",
    recipe: template,
    description: templateDescriptions[template],
    enabled: false,
    allowed_scopes:
      template === "onboarding"
        ? [
            "messages:read",
            "messages:write",
            "search:read",
            "files:read",
            "runtime:execute",
          ]
        : [
            "messages:read",
            "messages:write",
            "search:read",
            "files:read",
            "memory:read",
            "memory:write",
            "runtime:execute",
          ],
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
  };
}

export function draftOf(agent: Agent): Draft {
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
  };
}
