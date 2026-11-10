export type AgentGlobalSection =
  | "overview"
  | "connections"
  | "approvals"
  | "activity";

/*
 * Sections of the pre-5.3 agent card. The builder is one page now; each old
 * address opens the matching place of it (see `builderAnchor`), and
 * `/agents/:id/activity` opens the activity feed filtered by the agent.
 */
export type AgentDetailSection =
  | "overview"
  | "behavior"
  | "knowledge"
  | "automations"
  | "test"
  | "activity"
  | "settings";

export type AgentRoute =
  | { kind: "global"; section: AgentGlobalSection }
  | { kind: "agent"; agentID: string; section: AgentDetailSection };

const globalSections = new Set<AgentGlobalSection>([
  "connections",
  "approvals",
  "activity",
]);
const detailSections = new Set<AgentDetailSection>([
  "behavior",
  "knowledge",
  "automations",
  "test",
  "activity",
  "settings",
]);

export function agentRoute(path: string): AgentRoute {
  const parts = path.split("/").filter(Boolean);
  if (parts[0] !== "agents" || parts.length === 1) {
    return { kind: "global", section: "overview" };
  }
  const candidate = parts[1]!;
  if (
    globalSections.has(candidate as AgentGlobalSection) &&
    parts.length === 2
  ) {
    return { kind: "global", section: candidate as AgentGlobalSection };
  }
  // Compatibility for the pre-5.2 global routes. The UI no longer links to them.
  if (candidate === "sandbox" || candidate === "runs") {
    return { kind: "global", section: "overview" };
  }
  const sectionCandidate = parts[2] as AgentDetailSection | undefined;
  return {
    kind: "agent",
    agentID: decodeURIComponent(parts[1]!),
    section:
      sectionCandidate && detailSections.has(sectionCandidate)
        ? sectionCandidate
        : "overview",
  };
}

export type BuilderAnchor =
  | "top"
  | "identity"
  | "knowledge"
  | "skills"
  | "triggers"
  | "places"
  | "model"
  | "check"
  | "advanced";

export function builderAnchor(section: AgentDetailSection): BuilderAnchor {
  switch (section) {
    case "behavior":
      return "identity";
    case "knowledge":
      return "knowledge";
    case "automations":
      return "triggers";
    case "test":
      return "check";
    case "settings":
      return "advanced";
    default:
      return "top";
  }
}
