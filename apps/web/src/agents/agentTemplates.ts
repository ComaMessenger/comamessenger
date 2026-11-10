/*
 * Built-in roles. The server owns their default rules (recipe triggers) and
 * scopes; the client only offers them as starting points.
 */
export type AgentTemplate = "custom" | "summarizer" | "qa" | "onboarding";
