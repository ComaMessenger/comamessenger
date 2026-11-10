import type {
  AgentConfirmationMode,
  AgentConfirmationPolicy,
} from "@comamessenger/core";
import type { Skill } from "./capabilities";

/*
 * «Сам / после подтверждения» for every action of the agent. An action is
 * what a person reads in the builder; it covers one or more server tools that
 * always share the mode. The server enforces the policy of the published
 * version and its own floor (`confirmation_locked`); the builder only offers
 * what the server accepts.
 */

export type ConfirmableAction =
  | "post"
  | "direct"
  | "cards"
  | "collect"
  | "followup"
  | "react"
  | "remember";

export const actionTools: Record<ConfirmableAction, string[]> = {
  post: ["post_message", "reply_in_thread"],
  direct: ["send_direct_message"],
  cards: ["post_card", "update_card"],
  collect: ["start_collection"],
  followup: ["schedule_followup"],
  react: ["add_reaction"],
  remember: ["remember"],
};

/** Actions shown under each skill switch of block «Что умеет». */
export const skillActions: Record<Skill, ConfirmableAction[]> = {
  messages: ["post", "direct"],
  cards: ["cards", "collect"],
  followups: ["followup"],
  reactions: ["react"],
  memory: ["remember"],
};

/** Defaults of a new agent, mirroring the server. */
const defaults: Record<string, AgentConfirmationMode> = {
  send_direct_message: "confirm",
};

export function actionMode(
  policy: AgentConfirmationPolicy | undefined,
  action: ConfirmableAction,
): AgentConfirmationMode {
  return actionTools[action].some(
    (tool) => (policy?.[tool] ?? defaults[tool] ?? "auto") === "confirm",
  )
    ? "confirm"
    : "auto";
}

export function actionLocked(
  locked: readonly string[] | undefined,
  action: ConfirmableAction,
): boolean {
  return actionTools[action].some((tool) => locked?.includes(tool));
}

export function withActionMode(
  policy: AgentConfirmationPolicy | undefined,
  action: ConfirmableAction,
  mode: AgentConfirmationMode,
): AgentConfirmationPolicy {
  const next: AgentConfirmationPolicy = { ...(policy ?? {}) };
  for (const tool of actionTools[action]) next[tool] = mode;
  return next;
}

/**
 * Mode of an external tool in a binding: the connection policy wins, then the
 * per-tool choice, then the binding default (confirm when omitted).
 */
export function externalMode(
  binding: {
    require_write_confirmation?: boolean;
    confirmation_policy?: AgentConfirmationPolicy;
  },
  tool: string,
  connectionRequires: boolean,
): AgentConfirmationMode {
  if (connectionRequires) return "confirm";
  const chosen = binding.confirmation_policy?.[tool];
  if (chosen) return chosen;
  return binding.require_write_confirmation === false ? "auto" : "confirm";
}
