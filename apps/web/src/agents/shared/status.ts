import type { Agent } from "@comamessenger/core";

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
