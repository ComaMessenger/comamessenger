export type AgentGlobalSection =
  | "overview"
  | "connections"
  | "approvals"
  | "activity";

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
