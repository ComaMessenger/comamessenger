import { APIError } from "./api";
import { actionTools, type ConfirmableAction } from "./agentConfirmation";
import { draftChatIDs, emptyDraft, type AgentDraft } from "./agentDraft";
import type { Translate } from "./agentText";
import type {
  Agent,
  AgentLlmConnection,
  AgentRecipe,
  AgentRunToolCall,
  AgentTrigger,
  CreateAgentRequest,
  KnowledgeDocument,
  McpConnection,
} from "./types";

/*
 * Builder rules shared by the web page of six blocks and the phone's step
 * screens: what stops a publish, what a recipe still needs, which external
 * tools may be given, how a new draft is created and what is wrong in a
 * field. The clients only lay them out.
 */

/** A place of the builder a problem points to. */
export type AgentBuilderPlace =
  | "identity"
  | "places"
  | "knowledge"
  | "skills"
  | "triggers"
  | "model"
  | "advanced";

export type PublishBlocker = { key: string; anchor: AgentBuilderPlace };

/**
 * What stops publishing, computed from the local draft so the reason is
 * visible before saving. Server-only facts (keys of external agents, a legacy
 * provider key) come from the saved readiness.
 */
export function publishBlockers(
  agent: Agent,
  draft: AgentDraft,
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

/** Blockers that make a check impossible, not only a publish. */
export const checkBlockerKeys: ReadonlySet<string> = new Set([
  "chat_required",
  "llm_connection_required",
  "llm_connection_unavailable",
  "external_data_approval_required",
  "provider_model_required",
]);

/** Examples a custom agent is checked with (keys `agentExample_custom_N`). */
export const customExampleCount = 3;

type RecipeNeed = AgentRecipe["needs"][number];

/** The builder place that satisfies each recipe need. */
export const recipeNeedPlace: Record<RecipeNeed["kind"], AgentBuilderPlace> = {
  chats: "places",
  knowledge: "knowledge",
  schedule: "knowledge",
};

/** Whether the draft already has what a recipe needs. */
export function needDone(
  need: RecipeNeed,
  draft: AgentDraft,
  agent: Pick<Agent, "mcp_bindings">,
): boolean {
  const collections = (draft.knowledge_collection_ids ?? []).length > 0;
  switch (need.kind) {
    case "chats":
      return draft.chat_ids.length > 0;
    case "knowledge":
      return collections;
    case "schedule":
      // A slot table lives in a bound collection; an accounting system comes
      // through a workspace integration bound to the agent.
      return collections || (agent.mcp_bindings ?? []).length > 0;
    default:
      return false;
  }
}

export type AssignableTool = {
  name: string;
  description: string;
  readOnly: boolean;
};

/**
 * Tools of a connection an agent may be given: the assignable ones, and once
 * Core knows the catalog only those the server offers. A tool missing from
 * the catalog is treated as changing data, as the server does.
 */
export function assignableTools(connection: McpConnection): AssignableTool[] {
  const catalog = connection.tools ?? [];
  const known = new Map(catalog.map((tool) => [tool.name, tool]));
  const names = connection.assignable_tools ?? catalog.map((tool) => tool.name);
  return names
    .filter((name) => !connection.tools_refreshed_at || known.has(name))
    .map((name) => ({
      name,
      description: known.get(name)?.description ?? "",
      readOnly: known.get(name)?.read_only === true,
    }));
}

/** Spreadsheets `query_table` can read: CSV and XLSX files. */
export function isSpreadsheet(document: KnowledgeDocument): boolean {
  const name = (document.file_name ?? document.title).toLowerCase();
  const mime = document.file_mime ?? "";
  return (
    document.kind === "file" &&
    (name.endsWith(".csv") ||
      name.endsWith(".xlsx") ||
      mime === "text/csv" ||
      mime ===
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
  );
}

/** The connection a new agent starts with: one healthy workspace model. */
export function defaultConnection(
  connections: AgentLlmConnection[],
): AgentLlmConnection | undefined {
  const enabled = connections.filter((connection) => connection.enabled);
  return (
    enabled.find((connection) => connection.health_status === "healthy") ??
    enabled[0]
  );
}

/** i18n key of what stops creating a draft, or null. */
export function createAgentProblem(input: {
  name: string;
  chatID: string;
  recipe: AgentRecipe | null;
}): string | null {
  if (!input.name.trim()) return "agentCreateNameRequired";
  if (input.recipe && !input.chatID) return "agentCreateChatRequired";
  return null;
}

/**
 * The request of a new draft: a role from the catalog (instructions, scopes
 * and rules come from Core) or a custom agent, with its first chat and the
 * workspace model.
 */
export function newAgentRequest({
  recipe,
  name,
  chatID,
  connections,
  locale,
}: {
  recipe: AgentRecipe | null;
  name: string;
  chatID: string;
  connections: AgentLlmConnection[];
  locale: string;
}): CreateAgentRequest {
  const draft = emptyDraft(recipe ?? undefined, locale);
  const connection = defaultConnection(connections);
  return {
    ...draft,
    display_name: name.trim(),
    chat_ids: chatID ? [chatID] : [],
    enabled: false,
    ...(connection
      ? {
          llm_connection_id: connection.id,
          provider: connection.provider,
          endpoint_url: "",
          model: connection.default_model || draft.model,
        }
      : { llm_connection_id: undefined }),
  };
}

/**
 * Recipe rules are created by the server in UTC; they belong to the
 * creator's timezone so «every day at 09:00» means local 09:00.
 */
export function triggersToLocalize(
  triggers: AgentTrigger[],
  timezone: string,
): AgentTrigger[] {
  if (timezone === "UTC") return [];
  return triggers.filter((trigger) => trigger.timezone === "UTC");
}

/** Agent instructions limit, as in Core and the API schema. */
export const maxAgentInstructionsLength = 4000;
export const maxAgentNameLength = 120;
const handlePattern = /^[a-z0-9][a-z0-9_.-]{1,31}$/;
const costPattern = /^(?:|[0-9]+(?:\.[0-9]{1,8})?)$/;

/** Bounds of the numeric limits, as the API schema accepts them. */
export const agentNumberBounds = {
  max_output_tokens: [1, 1_000_000],
  max_tool_iterations: [0, 64],
  per_chat_concurrency: [1, 32],
  rate_limit_per_minute: [1, 100_000],
  execution_timeout_seconds: [30, 3600],
} as const;

export type AgentNumberField = keyof typeof agentNumberBounds;

export type DraftProblem = {
  field:
    | "display_name"
    | "description"
    | "handle"
    | "model"
    | "daily_cost_limit"
    | "monthly_cost_limit"
    | AgentNumberField;
  /** i18n key of the message. */
  key: string;
  place: AgentBuilderPlace;
};

/**
 * Field problems the server would reject a save for. A draft with any of
 * them is not saved; the field shows the message instead.
 */
export function draftProblems(draft: AgentDraft): DraftProblem[] {
  const result: DraftProblem[] = [];
  if (!draft.display_name.trim())
    result.push({
      field: "display_name",
      key: "agentNameRequired",
      place: "identity",
    });
  else if (draft.display_name.length > maxAgentNameLength)
    result.push({
      field: "display_name",
      key: "agentNameTooLong",
      place: "identity",
    });
  if ((draft.description ?? "").length > maxAgentInstructionsLength)
    result.push({
      field: "description",
      key: "agentTaskTooLong",
      place: "identity",
    });
  if (!handlePattern.test(draft.handle))
    result.push({ field: "handle", key: "agentHandleInvalid", place: "advanced" });
  if ((draft.model ?? "").length > 200)
    result.push({ field: "model", key: "agentModelTooLong", place: "advanced" });
  for (const field of ["daily_cost_limit", "monthly_cost_limit"] as const)
    if (!costPattern.test(draft[field] ?? ""))
      result.push({ field, key: "agentBudgetInvalid", place: "advanced" });
  for (const [field, [min, max]] of Object.entries(agentNumberBounds) as Array<
    [AgentNumberField, readonly [number, number]]
  >) {
    const value = draft[field];
    if (
      value !== undefined &&
      (!Number.isInteger(value) || value < min || value > max)
    )
      result.push({ field, key: "agentNumberOutOfRange", place: "advanced" });
  }
  return result;
}

/** Readable labels of actions a publish would let run without a person. */
export function loosenedLabels(t: Translate, keys: readonly string[]): string[] {
  const labels = keys.map((key) => {
    if (key.startsWith("mcp:")) {
      const [connection, tool] = key.slice(4).split("/");
      return t("agentLoosenedExternal", { connection, tool });
    }
    const action = (Object.keys(actionTools) as ConfirmableAction[]).find(
      (item) => actionTools[item].includes(key),
    );
    return action ? t(`agentAction_${action}`) : key;
  });
  return [...new Set(labels)];
}

/** Actions listed by a refused publish (`agent_confirmation_loosened`). */
export function loosenedOf(cause: unknown): string[] | null {
  if (!(cause instanceof APIError) || cause.code !== "agent_confirmation_loosened")
    return null;
  const listed = cause.details.loosened;
  return Array.isArray(listed) ? listed.map(String) : [];
}

const knownSteps = new Set([
  "get_chat_messages",
  "get_thread",
  "search_messages",
  "get_file_text",
  "list_members",
  "recall",
  "search_knowledge",
  "get_reactions",
  "get_collection",
  "post_message",
  "reply_in_thread",
  "add_reaction",
  "remember",
  "post_card",
  "update_card",
  "start_collection",
  "schedule_followup",
  "send_direct_message",
]);

/** «Read the chat», «Would send a card»: a tool step of a check in plain words. */
export function agentStepText(
  t: Translate,
  call: AgentRunToolCall,
  toolLabel: (name: string) => string,
): string {
  const known = knownSteps.has(call.tool_name);
  const text = known
    ? t(
        call.dry_run
          ? `agentStepWould_${call.tool_name}`
          : `agentStep_${call.tool_name}`,
      )
    : call.dry_run
      ? t("agentStepWouldExternal", { name: toolLabel(call.tool_name) })
      : t("agentStepExternal", { name: toolLabel(call.tool_name) });
  return call.status === "failed" ? t("agentStepFailed", { step: text }) : text;
}

export type ArchitectProblem =
  | { kind: "connection" }
  | { kind: "model" }
  | { kind: "budget" }
  | { kind: "busy" }
  | { kind: "expired" }
  | { kind: "other"; message: string };

/** What went wrong with the Architect; `describe` gives other errors a text. */
export function architectProblemOf(
  cause: unknown,
  describe: (cause: unknown) => string,
): ArchitectProblem {
  if (cause instanceof APIError) {
    switch (cause.code) {
      case "architect_connection_required":
        return { kind: "connection" };
      case "architect_model_error":
        return { kind: "model" };
      case "architect_budget_exceeded":
        return { kind: "budget" };
      case "architect_busy":
        return { kind: "busy" };
      case "architect_session_expired":
        return { kind: "expired" };
    }
  }
  return { kind: "other", message: describe(cause) };
}

/** i18n key of an Architect problem; `other` carries its own text. */
export function architectProblemKey(problem: ArchitectProblem | null): string {
  switch (problem?.kind) {
    case "model":
      return "architectModelError";
    case "budget":
      return "architectBudgetError";
    case "busy":
      return "architectBusyError";
    case "expired":
      return "architectExpired";
    case "connection":
      return "architectNoConnectionTitle";
    default:
      return "error";
  }
}

/*
 * The builder as steps (the phone): one screen per block of the web page, in
 * the order a person thinks about a new colleague — who, where, what it
 * knows, what it can do, when it starts — and the check with the publish.
 */
export const agentBuilderSteps = [
  "role",
  "places",
  "knowledge",
  "skills",
  "triggers",
  "review",
] as const;

export type AgentBuilderStep = (typeof agentBuilderSteps)[number];

/** The step that holds a builder place; advanced settings open from review. */
export function stepOfPlace(place: AgentBuilderPlace): AgentBuilderStep {
  switch (place) {
    case "identity":
      return "role";
    case "places":
    case "knowledge":
    case "skills":
    case "triggers":
      return place;
    default:
      return "review";
  }
}

export function isAgentBuilderStep(value: unknown): value is AgentBuilderStep {
  return (agentBuilderSteps as readonly unknown[]).includes(value);
}

/** Field problems shown on a step; «Далее» waits until they are fixed. */
export function stepProblems(
  step: AgentBuilderStep,
  draft: AgentDraft,
): DraftProblem[] {
  return draftProblems(draft).filter(
    (problem) => stepOfPlace(problem.place) === step,
  );
}

/**
 * Whether a step has what it asks for, for the progress of the steps list.
 * Only the role and places are required; the rest is filled when chosen.
 */
export function stepFilled(
  step: AgentBuilderStep,
  draft: AgentDraft,
  triggers: AgentTrigger[] | undefined,
): boolean {
  switch (step) {
    case "role":
      return (
        stepProblems("role", draft).length === 0 &&
        (draft.description ?? "").trim().length > 0
      );
    case "places":
      return draftChatIDs(draft).length > 0;
    case "knowledge":
      return (
        (draft.read_chat_ids ?? draft.chat_ids).length > 0 ||
        (draft.knowledge_collection_ids ?? []).length > 0
      );
    case "skills":
      return draft.allowed_scopes.some((scope) =>
        [
          "messages:write",
          "messages:interactive",
          "reactions:write",
          "followups:write",
          "memory:write",
        ].includes(scope),
      ) || (draft.mcp_bindings ?? []).length > 0;
    case "triggers":
      return (triggers ?? []).some((trigger) => trigger.enabled);
    case "review":
      return false;
  }
}
