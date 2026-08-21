import type { Permission as CorePermission, User } from "@comamessenger/core";

export type Permission = CorePermission;

export const permissions = [
  "members.manage",
  "invitations.manage",
  "workspace.settings",
  "workspace.policies",
  "branding.manage",
  "integrations.manage",
  "agents.manage",
  "audit.read",
  "chats.moderate",
] as const satisfies readonly Permission[];

export const permissionLabelKeys: Record<Permission, string> = {
  "members.manage": "permissionMembersManage",
  "invitations.manage": "permissionInvitationsManage",
  "workspace.settings": "permissionWorkspaceSettings",
  "workspace.policies": "permissionWorkspacePolicies",
  "branding.manage": "permissionBrandingManage",
  "integrations.manage": "permissionIntegrationsManage",
  "agents.manage": "permissionAgentsManage",
  "audit.read": "permissionAuditRead",
  "chats.moderate": "permissionChatsModerate",
};

export type SettingsPageID =
  | "profile"
  | "notifications"
  | "security"
  | "workspace"
  | "workspace-general"
  | "workspace-members"
  | "workspace-invitations"
  | "workspace-policies"
  | "customization"
  | "infrastructure"
  | "agents"
  | "audit";

export type SettingsEntry = {
  id: SettingsPageID;
  path: `/settings/${string}`;
  group: "personal" | "workspace";
  labelKey: string;
  parent?: SettingsPageID;
  access?: {
    permission?: Permission;
    anyOf?: readonly Permission[];
    ownerOnly?: boolean;
  };
};

export const settingsRegistry: readonly SettingsEntry[] = [
  {
    id: "profile",
    path: "/settings/profile",
    group: "personal",
    labelKey: "profile",
  },
  {
    id: "notifications",
    path: "/settings/notifications",
    group: "personal",
    labelKey: "notifications",
  },
  {
    id: "security",
    path: "/settings/security",
    group: "personal",
    labelKey: "security",
  },
  {
    id: "workspace",
    path: "/settings/workspace",
    group: "workspace",
    labelKey: "workspace",
    access: {
      anyOf: [
        "members.manage",
        "invitations.manage",
        "workspace.settings",
        "workspace.policies",
      ],
    },
  },
  {
    id: "workspace-general",
    path: "/settings/workspace/general",
    group: "workspace",
    parent: "workspace",
    labelKey: "workspaceGeneral",
    access: { permission: "workspace.settings" },
  },
  {
    id: "workspace-members",
    path: "/settings/workspace/members",
    group: "workspace",
    parent: "workspace",
    labelKey: "membersAndAccess",
    access: { permission: "members.manage" },
  },
  {
    id: "workspace-invitations",
    path: "/settings/workspace/invitations",
    group: "workspace",
    parent: "workspace",
    labelKey: "invitationPolicy",
    access: { permission: "invitations.manage" },
  },
  {
    id: "workspace-policies",
    path: "/settings/workspace/policies",
    group: "workspace",
    parent: "workspace",
    labelKey: "creationPolicy",
    access: { permission: "workspace.policies" },
  },
  {
    id: "customization",
    path: "/settings/customization",
    group: "workspace",
    labelKey: "customization",
    access: { permission: "branding.manage" },
  },
  {
    id: "infrastructure",
    path: "/settings/infrastructure",
    group: "workspace",
    labelKey: "connections",
    access: { permission: "integrations.manage" },
  },
  {
    id: "agents",
    path: "/settings/agents",
    group: "workspace",
    labelKey: "agentsTitle",
    access: { permission: "agents.manage" },
  },
  {
    id: "audit",
    path: "/settings/audit",
    group: "workspace",
    labelKey: "audit",
    access: { permission: "audit.read" },
  },
] as const;

export function permissionsOf(user: User): ReadonlySet<Permission> {
  return new Set(user.permissions);
}

export function canAccessSettings(user: User, entry: SettingsEntry): boolean {
  if (user.role === "owner") return true;
  if (
    (entry.id === "workspace" || entry.id === "workspace-invitations") &&
    user.can_create_invitations
  )
    return true;
  if (entry.access?.ownerOnly) return false;
  const granted = permissionsOf(user);
  if (entry.access?.permission) return granted.has(entry.access.permission);
  if (entry.access?.anyOf)
    return entry.access.anyOf.some((permission) => granted.has(permission));
  return true;
}

export function hasPermission(user: User, required: Permission): boolean {
  return user.role === "owner" || permissionsOf(user).has(required);
}

export function canAccessSettingsPage(
  user: User,
  pageID: SettingsPageID,
): boolean {
  const entry = settingsRegistry.find((item) => item.id === pageID);
  return entry ? canAccessSettings(user, entry) : false;
}

export function visibleSettings(user: User): readonly SettingsEntry[] {
  return settingsRegistry.filter(
    (entry) => !entry.parent && canAccessSettings(user, entry),
  );
}

export function visibleChildSettings(
  user: User,
  parent: SettingsPageID,
): readonly SettingsEntry[] {
  return settingsRegistry.filter(
    (entry) => entry.parent === parent && canAccessSettings(user, entry),
  );
}

export function parentSettingsPage(pageID: SettingsPageID): SettingsPageID {
  return (
    settingsRegistry.find((entry) => entry.id === pageID)?.parent ?? pageID
  );
}

export function settingForPath(path: string): SettingsEntry | undefined {
  return settingsRegistry.find((entry) => entry.path === path);
}
