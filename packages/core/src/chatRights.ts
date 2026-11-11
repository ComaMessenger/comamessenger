import { grantsPermission } from "./blocks";
import type { Chat, ChatMember } from "./types";

/**
 * What the reader may do with a chat and its members, as the server decides
 * it (core/internal/chat/chat.go). Used to show or hide actions; the server
 * re-checks every request.
 */
export type ChatViewer = {
  actorID: string;
  /** Role in the workspace: owner, admin or member. */
  orgRole: string;
  /** Workspace permissions; `chats.moderate` manages any group or channel. */
  permissions: readonly string[];
};

export type ChatRole = "owner" | "admin" | "member";

export type ChatRights = {
  /** Rename, change the description and openness: owners and admins of the chat. */
  edit: boolean;
  /** Add people: owners, admins and workspace moderators. */
  addMembers: boolean;
  /** Pin and unpin messages: the server's `chat.manage`. */
  pin: boolean;
  /** Leave the chat; a direct chat cannot be left. */
  leave: boolean;
  /**
   * The reader is the only owner: the server refuses to let them leave until
   * someone else becomes an owner.
   */
  lastOwner: boolean;
  /** Archive for everyone: owners, admins and workspace moderators. */
  archive: boolean;
};

export type MemberRights = {
  /** Roles the member can be given now, without their current one. */
  roles: ChatRole[];
  remove: boolean;
};

const chatRoles: ChatRole[] = ["owner", "admin", "member"];

function managerRole(role: string | undefined) {
  return role === "owner" || role === "admin";
}

export function moderatesChats(viewer: ChatViewer) {
  return grantsPermission(viewer.orgRole, viewer.permissions, "chats.moderate");
}

/** Owners among the members; the last one may not step down or leave. */
export function ownerCount(members: readonly ChatMember[]) {
  return members.filter((member) => member.role === "owner").length;
}

export function chatRights(
  chat: Chat,
  viewer: ChatViewer,
  members: readonly ChatMember[] = [],
): ChatRights {
  const shared = chat.kind !== "direct";
  const manager = shared && managerRole(chat.role);
  const moderator = shared && moderatesChats(viewer);
  const lastOwner =
    shared && chat.role === "owner" && members.length > 0
      ? ownerCount(members) <= 1
      : false;
  return {
    edit: manager,
    addMembers: manager || moderator,
    pin: managerRole(chat.role),
    leave: shared,
    lastOwner,
    archive: manager || moderator,
  };
}

/**
 * Role changes and removal of one member. The reader acts on others only —
 * leaving is a separate action. Ownership is given and taken by owners; the
 * last owner keeps the role. Agents keep the member role: the web shows them
 * with an agent tag instead.
 */
export function memberRights(
  chat: Chat,
  viewer: ChatViewer,
  target: ChatMember,
  members: readonly ChatMember[],
): MemberRights {
  const none: MemberRights = { roles: [], remove: false };
  if (chat.kind === "direct" || target.actor_id === viewer.actorID) return none;
  const manager = managerRole(chat.role);
  if (!manager && !moderatesChats(viewer)) return none;
  const owner = chat.role === "owner";
  const targetOwner = target.role === "owner";
  if (targetOwner && !owner) return none;
  const soleOwner = targetOwner && ownerCount(members) <= 1;
  const roles =
    target.type === "agent"
      ? []
      : chatRoles.filter(
          (role) =>
            role !== target.role &&
            (role !== "owner" || owner) &&
            !(soleOwner && role !== "owner"),
        );
  return { roles, remove: !soleOwner };
}
