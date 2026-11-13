import type {
  Message,
  MessageAction,
  MessageActionAudience,
  MessageBlocks,
} from "./types";

/** The newest blocks schema this client understands. */
export const supportedBlocksVersion = 1;

/**
 * Returns the blocks a client should render, or null when the message must be
 * shown as plain text: no blocks, a deleted message, or a schema version newer
 * than this client. The body always carries the text fallback.
 */
export function renderableBlocks(
  message: Pick<Message, "blocks" | "deleted_at">,
): MessageBlocks | null {
  const blocks = message.blocks;
  if (!blocks || message.deleted_at) return null;
  if (
    !Number.isInteger(blocks.version) ||
    blocks.version < 1 ||
    blocks.version > supportedBlocksVersion
  )
    return null;
  if (!blocks.card && !blocks.actions?.length && !blocks.sources?.length)
    return null;
  return blocks;
}

/** A card mirrors a pending tool confirmation when Core bound its buttons. */
export function isConfirmationCard(blocks: MessageBlocks): boolean {
  return (blocks.actions ?? []).some(
    (action) => action.binding?.kind === "tool_confirmation",
  );
}

export type ActionViewer = {
  actorID: string;
  chatRole?: "owner" | "admin" | "member";
  orgRole?: "owner" | "admin" | "member";
  /** Evaluates a workspace permission; omitted when the client cannot tell. */
  hasPermission?(permission: string): boolean;
};

/**
 * Whether the viewer belongs to the action audience. `undefined` means the
 * client cannot decide (for example a permission it cannot evaluate); the
 * button then stays pressable and the server has the final word.
 */
export function audienceIncludes(
  audience: MessageActionAudience | undefined,
  viewer: ActionViewer,
): boolean | undefined {
  if (!audience) return true;
  const actorIDs = audience.actor_ids ?? [];
  const chatRoles = audience.chat_roles ?? [];
  const orgRoles = audience.org_roles ?? [];
  const permissions = audience.permissions ?? [];
  if (
    !actorIDs.length &&
    !chatRoles.length &&
    !orgRoles.length &&
    !permissions.length
  )
    return true;
  if (actorIDs.includes(viewer.actorID)) return true;
  let unknown = false;
  if (chatRoles.length) {
    if (!viewer.chatRole) unknown = true;
    else if (chatRoles.includes(viewer.chatRole)) return true;
  }
  if (orgRoles.length) {
    if (!viewer.orgRole) unknown = true;
    else if (orgRoles.includes(viewer.orgRole)) return true;
  }
  if (permissions.length) {
    if (!viewer.hasPermission) unknown = true;
    else if (permissions.some((item) => viewer.hasPermission!(item)))
      return true;
  }
  return unknown ? undefined : false;
}

/**
 * Presentation state of a card button.
 * - `available` — the viewer may press it;
 * - `pending` — this client is sending the press;
 * - `pressed` — the viewer pressed it;
 * - `chosen_other` — the viewer picked another button of the same group;
 * - `taken` — a single-use action was pressed by someone else;
 * - `closed` — the server closed the action (decided, expired, superseded);
 * - `unavailable` — the action is meant for other people.
 */
export type ActionState =
  | "available"
  | "pending"
  | "pressed"
  | "chosen_other"
  | "taken"
  | "closed"
  | "unavailable";

/** Client-side facts about the latest press attempt of one action. */
export type LocalActionState = {
  pending?: boolean;
  /** The server answered that the viewer may not press this action. */
  forbidden?: boolean;
  /** The server answered that the action was already closed. */
  closed?: boolean;
};

export function actionState(
  action: MessageAction,
  blocks: MessageBlocks,
  viewer: ActionViewer,
  local: LocalActionState = {},
): ActionState {
  if (action.responses.some((item) => item.actor_id === viewer.actorID))
    return "pressed";
  if (
    action.group &&
    (blocks.actions ?? []).some(
      (other) =>
        other.id !== action.id &&
        other.group === action.group &&
        other.responses.some((item) => item.actor_id === viewer.actorID),
    )
  )
    return "chosen_other";
  if (local.pending) return "pending";
  if (action.closed || local.closed) {
    if (action.limit === "single" && action.responses.length > 0)
      return "taken";
    // A decided group (for example approve/deny) closes the losing buttons too.
    if (
      action.group &&
      (blocks.actions ?? []).some(
        (other) =>
          other.group === action.group &&
          other.limit === "single" &&
          other.responses.length > 0,
      )
    )
      return "taken";
    return "closed";
  }
  if (local.forbidden) return "unavailable";
  if (audienceIncludes(action.allowed, viewer) === false) return "unavailable";
  return "available";
}

/** Only `available` buttons send a request; everything else is display. */
export function canPress(state: ActionState): boolean {
  return state === "available";
}

/** The first responder of a single-use action or its decided group. */
export function actionResponder(
  action: MessageAction,
  blocks: MessageBlocks,
): { actorID: string; respondedAt: string } | null {
  const candidates = action.responses.length
    ? [action]
    : (blocks.actions ?? []).filter(
        (other) =>
          action.group &&
          other.group === action.group &&
          other.responses.length > 0,
      );
  const response = candidates[0]?.responses[0];
  return response
    ? { actorID: response.actor_id, respondedAt: response.responded_at }
    : null;
}

/**
 * Maps a failed press to a local state. API errors carry stable codes; the
 * server stays the authority and the next message.updated replaces the guess.
 */
export function pressFailure(code: string | undefined): {
  local: LocalActionState;
  kind: "forbidden" | "closed" | "conflict" | "error";
} {
  switch (code) {
    case "forbidden":
      return { local: { forbidden: true }, kind: "forbidden" };
    case "action_closed":
      return { local: { closed: true }, kind: "closed" };
    case "action_conflict":
      return { local: {}, kind: "conflict" };
    default:
      return { local: {}, kind: "error" };
  }
}

/** Server status labels of confirmation cards, mapped to stable keys. */
const confirmationStatuses: Record<string, ConfirmationStatus> = {
  "Approval required": "pending",
  Approved: "approved",
  Done: "done",
  Failed: "failed",
  Denied: "denied",
  Expired: "expired",
};

export type ConfirmationStatus =
  | "pending"
  | "approved"
  | "done"
  | "failed"
  | "denied"
  | "expired";

export function confirmationStatus(
  blocks: MessageBlocks,
): ConfirmationStatus | null {
  const label = blocks.card?.status?.label;
  return label ? (confirmationStatuses[label] ?? null) : null;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Arguments that only matter to machines and never reach the card. */
const technicalArguments = new Set([
  "client_msg_id",
  "body_format",
  "thread_root_id",
  "mentioned_actor_ids",
  "file_ids",
  "namespace",
  "embedding",
  "embedding_model",
  "query_embedding",
  "before_seq",
  "limit",
]);

export type ConfirmationField =
  | { kind: "text"; key: string; value: string }
  | { kind: "actor"; key: string; actorID: string }
  | { kind: "chat"; key: string; chatID: string };

/**
 * Turns the raw tool arguments Core copies into the card into fields a person
 * can read: identifiers become actor or chat references, technical keys and
 * unresolvable identifiers disappear.
 */
export function confirmationFields(blocks: MessageBlocks): ConfirmationField[] {
  const fields: ConfirmationField[] = [];
  for (const field of blocks.card?.fields ?? []) {
    if (technicalArguments.has(field.label)) continue;
    const value = field.value.trim();
    if (uuidPattern.test(value)) {
      if (field.label === "actor_id" || field.label.endsWith("_actor_id"))
        fields.push({ kind: "actor", key: field.label, actorID: value });
      else if (field.label === "chat_id")
        fields.push({ kind: "chat", key: field.label, chatID: value });
      continue;
    }
    if (!value) continue;
    fields.push({ kind: "text", key: field.label, value });
  }
  return fields;
}

/** Tool name of a confirmation card; Core uses it as the card title. */
export function confirmationTool(blocks: MessageBlocks): string {
  return blocks.card?.title ?? "";
}

const granularAgentPermissions = new Set([
  "agents.build",
  "agents.publish",
  "agents.approve",
  "agents.observe",
]);

/**
 * Mirrors Core's permission check for display decisions (which buttons look
 * pressable). The server re-checks every press.
 */
export function grantsPermission(
  role: string,
  permissions: readonly string[],
  required: string,
): boolean {
  if (role === "owner") return true;
  if (role !== "admin" && role !== "member") return false;
  return (
    permissions.includes(required) ||
    (permissions.includes("agents.manage") &&
      granularAgentPermissions.has(required))
  );
}
