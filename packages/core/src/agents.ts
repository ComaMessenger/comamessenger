import type { MessengerAPI } from "./api";
import { hasPermission } from "./settings";
import {
  agentRunErrorText,
  chatName,
  formatCost,
  toolLabel,
  type Translate,
} from "./agentText";
import type {
  Agent,
  AgentRecipe,
  AgentRun,
  AgentRunToolCall,
  AgentToolConfirmation,
  AgentTrigger,
  Chat,
  ChatAgent,
  ChatAgentTrigger,
  User,
} from "./types";

/*
 * Agent platform logic shared by the web and the phone: who may do what,
 * the human status of an agent, and runs, steps and pending actions in words.
 * Texts come from the clients' catalogs through `t`; both clients use the same
 * keys (i18next with ICU).
 */

/** The part of an i18next `t` these helpers need (same as `Translate`). */
export type AgentTranslate = Translate;

/* ---------- Access ---------- */

export type AgentAccess = {
  canBuild: boolean;
  canPublish: boolean;
  canApprove: boolean;
  canObserve: boolean;
  canIntegrate: boolean;
  /** knowledge.manage: may create collections in the Knowledge base. */
  canManageKnowledge: boolean;
  /**
   * May list the agents of the workspace and their runs (the server's
   * «view»: observe, build, publish or approve).
   */
  canView: boolean;
  /** Any agent permission opens the platform. */
  allowed: boolean;
};

export function agentAccess(user: User): AgentAccess {
  const canBuild = hasPermission(user, "agents.build");
  const canPublish = hasPermission(user, "agents.publish");
  const canApprove = hasPermission(user, "agents.approve");
  const canObserve = hasPermission(user, "agents.observe");
  const canIntegrate = hasPermission(user, "integrations.manage");
  const canView = canBuild || canPublish || canApprove || canObserve;
  return {
    canBuild,
    canPublish,
    canApprove,
    canObserve,
    canIntegrate,
    canManageKnowledge: hasPermission(user, "knowledge.manage"),
    canView,
    allowed: canView || canIntegrate,
  };
}

/* ---------- Status ---------- */

/*
 * One human status per agent, in priority order: waiting for a person beats a
 * problem, a problem beats pause, pause beats draft. The reason of «needs
 * attention» is an i18n key the card shows next to the status.
 */
export type HumanStatus =
  | { kind: "approval"; count: number }
  | { kind: "attention"; reason: string }
  | { kind: "paused" }
  | { kind: "draft" }
  | { kind: "working"; changed: boolean };

export function humanStatus(agent: Agent, pendingApprovals = 0): HumanStatus {
  if (pendingApprovals > 0)
    return { kind: "approval", count: pendingApprovals };
  const published = agent.published_version != null;
  const blocker = agent.readiness.blockers[0];
  if (
    agent.operational_status === "needs_attention" ||
    agent.readiness.state === "error"
  )
    return {
      kind: "attention",
      reason: blocker ? `agentBlocker_${blocker}` : "agentAttention_runs",
    };
  if (published && blocker && !agent.has_unpublished_changes)
    return { kind: "attention", reason: `agentBlocker_${blocker}` };
  if (agent.operational_status === "paused") return { kind: "paused" };
  if (!published) return { kind: "draft" };
  return { kind: "working", changed: agent.has_unpublished_changes };
}

export function statusTone(
  status: HumanStatus,
): "success" | "warning" | "danger" | "neutral" {
  switch (status.kind) {
    case "working":
      return "success";
    case "approval":
      return "warning";
    case "attention":
      return "danger";
    default:
      return "neutral";
  }
}

/** The label of a status chip. */
export function humanStatusLabel(t: AgentTranslate, status: HumanStatus) {
  if (status.kind === "approval")
    return t("agentStatus_approval", { count: status.count });
  if (status.kind === "working" && status.changed)
    return t("agentStatus_workingChanged");
  return t(`agentStatus_${status.kind}`);
}

/** Pending actions per agent, for the status of each card. */
export function pendingByAgent(
  approvals: readonly AgentToolConfirmation[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const approval of approvals)
    counts.set(approval.agent_id, (counts.get(approval.agent_id) ?? 0) + 1);
  return counts;
}

/* ---------- What an agent reads, does and when it starts ---------- */

const readScopes: Array<[string, string]> = [
  ["messages:read", "acReadMessages"],
  ["files:read", "acReadFiles"],
  ["search:read", "acReadSearch"],
  ["members:read", "acReadMembers"],
  ["chats:read", "acReadChats"],
  ["memory:read", "acReadMemory"],
  ["tables:read", "acReadTables"],
];

const writeScopes: Array<[string, string]> = [
  ["messages:write", "acDoWrite"],
  ["reactions:write", "acDoReact"],
  ["messages:interactive", "acDoInteractive"],
  ["followups:write", "acDoFollowups"],
  ["memory:write", "acDoMemory"],
];

type Described = Pick<ChatAgent, "scopes" | "knowledge_collection_count">;

/** What the agent reads, in plain language. */
export function describeReads(agent: Described, t: AgentTranslate): string[] {
  const scopes = new Set<string>(agent.scopes);
  const lines = readScopes
    .filter(([scope]) => scopes.has(scope))
    .map(([, key]) => t(key));
  if (scopes.has("knowledge:read"))
    lines.push(
      t("acReadKnowledge", { count: agent.knowledge_collection_count }),
    );
  return lines;
}

/** What the agent may do, in plain language. */
export function describeActions(
  agent: Pick<ChatAgent, "scopes">,
  t: AgentTranslate,
): string[] {
  const scopes = new Set<string>(agent.scopes);
  const lines = writeScopes
    .filter(([scope]) => scopes.has(scope))
    .map(([, key]) => t(key));
  return lines.length ? lines : [t("acDoNothing")];
}

function weekdays(days: number[], locale: string): string {
  const format = new Intl.DateTimeFormat(locale, { weekday: "short" });
  // 2026-11-08 is a Sunday: index 0 matches the server's day numbering.
  return [...days]
    .sort((left, right) => ((left + 6) % 7) - ((right + 6) % 7))
    .map((day) => format.format(new Date(Date.UTC(2026, 10, 8 + day, 12))))
    .join(", ");
}

/** How the agent starts, in plain language. */
export function describeTriggers(
  agent: Pick<ChatAgent, "triggers">,
  t: AgentTranslate,
  locale: string,
): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const trigger of agent.triggers) {
    let line: string;
    switch (trigger.type) {
      case "mention":
        line = t("acStartMention");
        break;
      case "command":
        line = t("acStartCommand", { command: trigger.command ?? "" });
        break;
      case "keyword":
        line = t("acStartKeyword");
        break;
      case "every_message":
        line = t("acStartEveryMessage");
        break;
      case "event":
        line = t("acStartEvent");
        break;
      case "schedule": {
        const schedule = trigger.schedule;
        if (!schedule) continue;
        const time = `${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`;
        line =
          schedule.days_of_week.length === 0 ||
          schedule.days_of_week.length === 7
            ? t("acStartScheduleDaily", { time })
            : t("acStartSchedule", {
                days: weekdays(schedule.days_of_week, locale),
                time,
              });
        break;
      }
      default:
        continue;
    }
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines.length ? lines : [t("acStartNone")];
}

/**
 * Enabled launch rules of an agent in the shape of a chat agent's triggers,
 * so the agent card says «when it starts» in the same words as a chat.
 */
export function chatTriggersOf(
  triggers: readonly AgentTrigger[],
): ChatAgentTrigger[] {
  const result: ChatAgentTrigger[] = [];
  for (const trigger of triggers) {
    if (!trigger.enabled) continue;
    const config = (trigger.config ?? {}) as Record<string, unknown>;
    switch (trigger.type) {
      case "mention":
      case "keyword":
      case "every_message":
      case "event":
        result.push({ type: trigger.type });
        break;
      case "command":
        result.push({
          type: "command",
          command: String(config.command ?? "").replace(/^\/+/, ""),
        });
        break;
      case "schedule":
        result.push({
          type: "schedule",
          schedule: {
            hour: Number(config.hour ?? 9),
            minute: Number(config.minute ?? 0),
            days_of_week: Array.isArray(config.days_of_week)
              ? (config.days_of_week as number[])
              : [],
            timezone: trigger.timezone,
          },
        });
        break;
      default:
        break;
    }
  }
  return result;
}

/* ---------- Runs ---------- */

const knownTriggers = new Set([
  "mention",
  "command",
  "keyword",
  "every_message",
  "schedule",
  "event",
  "message_action",
  "collection",
  "followup",
  "webhook",
  "confirmation",
]);

/** What started a run: a trigger kind, «check» for a dry run, or «manual». */
export function runTrigger(run: AgentRun): string {
  if (run.dry_run || run.input.sandbox === true) return "check";
  const type =
    typeof run.input.trigger_type === "string" ? run.input.trigger_type : "";
  if (knownTriggers.has(type)) return type;
  if (run.scheduled_for) return "schedule";
  return "manual";
}

export function runFinished(run: Pick<AgentRun, "status">): boolean {
  return !["queued", "running"].includes(run.status);
}

export function runFailed(run: Pick<AgentRun, "status">): boolean {
  return run.status === "failed" || run.status === "timed_out";
}

/** Seconds between start and finish; 0 while the run has not finished. */
export function runSeconds(
  run: Pick<AgentRun, "started_at" | "finished_at">,
): number {
  if (!run.started_at || !run.finished_at) return 0;
  return (
    (new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()) /
    1000
  );
}

/** The answer text a run produced, when the server kept a preview. */
export function runPreview(run: AgentRun): string {
  return typeof run.result_summary.preview === "string"
    ? run.result_summary.preview
    : "";
}

/** Why a run did not finish, in words. */
export function runErrorText(t: AgentTranslate, run: AgentRun): string {
  if (run.status === "canceled") return t("agentVerdictCanceled");
  if (run.status === "timed_out") return t("agentRunError_run_timeout");
  return agentRunErrorText(t, run.error_code);
}

/** «answered a mention in “Hall 1”», «could not finish: …». */
export function runSentence(
  t: AgentTranslate,
  run: AgentRun,
  chats: readonly Chat[],
): string {
  const chat = chats.find((item) => item.id === run.chat_id);
  const where = chat ? chatName(chat) : "";
  const trigger = runTrigger(run);
  if (run.status === "queued" || run.status === "running")
    return where
      ? t("agentFeedWorkingIn", { chat: where })
      : t("agentFeedWorking");
  if (run.status === "canceled") return t("agentFeedCanceled");
  if (run.status === "failed" || run.status === "timed_out")
    return t("agentFeedFailed", {
      reason:
        run.status === "timed_out"
          ? t("agentRunError_run_timeout")
          : agentRunErrorText(t, run.error_code),
    });
  return where
    ? t(`agentFeedDone_${trigger}`, { chat: where })
    : t(`agentFeedDoneNoChat_${trigger}`);
}

/** Runs of today (dry runs aside), failures among them and the spending. */
export function todayActivity(
  runs: readonly AgentRun[],
  now: Date = new Date(),
): {
  runs: AgentRun[];
  failures: number;
  /** Amount per currency, in the order the currencies first appear. */
  spending: Array<[string, number]>;
} {
  const day = now.toDateString();
  const today = runs.filter(
    (run) => new Date(run.created_at).toDateString() === day && !run.dry_run,
  );
  const spending = new Map<string, number>();
  for (const run of today)
    spending.set(
      run.currency,
      (spending.get(run.currency) ?? 0) + Number(run.cost || 0),
    );
  return {
    runs: today,
    failures: today.filter(runFailed).length,
    spending: [...spending.entries()],
  };
}

/** «$0.12 + 30 ₽»; the zero of `fallbackCurrency` when nothing was spent. */
export function formatSpending(
  spending: ReadonlyArray<[string, number]>,
  locale: string,
  fallbackCurrency = "USD",
): string {
  return (
    spending
      .map(([currency, amount]) => formatCost(amount, currency, locale))
      .join(" + ") || formatCost(0, fallbackCurrency, locale)
  );
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

/** «Read the chat», «Would send a card»: a tool step in plain words. */
export function stepText(
  t: AgentTranslate,
  call: AgentRunToolCall,
  label: (name: string) => string = (name) => toolLabel(t, name),
): string {
  const known = knownSteps.has(call.tool_name);
  const text = known
    ? t(
        call.dry_run
          ? `agentStepWould_${call.tool_name}`
          : `agentStep_${call.tool_name}`,
      )
    : call.dry_run
      ? t("agentStepWouldExternal", { name: label(call.tool_name) })
      : t("agentStepExternal", { name: label(call.tool_name) });
  return call.status === "failed" ? t("agentStepFailed", { step: text }) : text;
}

/* ---------- Pending actions ---------- */

function excerpt(value: unknown, length = 160) {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

/**
 * What a pending tool call would do, in words. Arguments are summarized only
 * for the tools the client understands; the raw request stays in details.
 */
export function approvalText(
  t: AgentTranslate,
  confirmation: AgentToolConfirmation,
  chats: readonly Chat[],
): { action: string; quote: string } {
  const args = confirmation.arguments as Record<string, unknown>;
  const chat = chats.find((item) => item.id === args.chat_id);
  const where = chat ? chatName(chat) : "";
  switch (confirmation.tool_name) {
    case "post_message":
      return {
        action: where
          ? t("agentApprovalPostIn", { chat: where })
          : t("agentApprovalPost"),
        quote: excerpt(args.body),
      };
    case "reply_in_thread":
      return {
        action: where
          ? t("agentApprovalReplyIn", { chat: where })
          : t("agentApprovalReply"),
        quote: excerpt(args.body),
      };
    case "send_direct_message":
      return { action: t("agentApprovalDirect"), quote: excerpt(args.body) };
    case "add_reaction":
      return {
        action: t("agentApprovalReaction", { emoji: excerpt(args.emoji, 16) }),
        quote: "",
      };
    case "remember":
      return {
        action: t("agentApprovalRemember", { key: excerpt(args.key, 80) }),
        quote: "",
      };
    default:
      return { action: toolLabel(t, confirmation.tool_name), quote: "" };
  }
}

/* ---------- Check (dry run) ---------- */

function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/**
 * One dry run of the agent draft in a chat: nothing is sent to chats. Polls
 * until the run finishes (up to ~6 minutes) and reports every state; stops
 * quietly when `signal` aborts (another check started, the screen closed).
 * Returns the last state, or null if aborted.
 */
export async function runAgentCheck({
  api,
  agentID,
  chatID,
  prompt,
  runID = crypto.randomUUID(),
  signal,
  onUpdate,
  interval = 1_000,
}: {
  api: Pick<MessengerAPI, "invokeAgent" | "agentRun">;
  agentID: string;
  chatID: string;
  prompt: string;
  /** Client run id (a UUID) that makes the request idempotent. */
  runID?: string;
  signal: AbortSignal;
  onUpdate(run: AgentRun): void;
  /** Polling step in milliseconds for the first ten polls; doubled after. */
  interval?: number;
}): Promise<AgentRun | null> {
  let state = await api.invokeAgent(agentID, {
    chat_id: chatID,
    client_run_id: runID,
    chain_depth: 0,
    timeout_seconds: 600,
    max_attempts: 1,
    dry_run: true,
    input: { prompt, sandbox: true, publish: false },
  });
  if (signal.aborted) return null;
  onUpdate(state);
  for (let attempt = 0; attempt < 180 && !runFinished(state); attempt++) {
    try {
      await pause(attempt < 10 ? interval : interval * 2, signal);
    } catch {
      return null;
    }
    state = await api.agentRun(state.id);
    if (signal.aborted) return null;
    onUpdate(state);
  }
  return state;
}

/** Blockers that make a check impossible, not only a publish. */
export const checkBlockers: ReadonlySet<string> = new Set([
  "chat_required",
  "llm_connection_required",
  "llm_connection_unavailable",
  "external_data_approval_required",
  "provider_model_required",
]);
