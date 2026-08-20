import type { Permission as CorePermission, User } from "@comamessenger/core";

export type Permission = CorePermission;

export const permissions = [
  "members.manage",
  "invitations.manage",
  "workspace.settings",
  "workspace.policies",
  "branding.manage",
  "integrations.manage",
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
  "audit.read": "permissionAuditRead",
  "chats.moderate": "permissionChatsModerate",
};

export type SettingsPageID =
  | "profile"
  | "notifications"
  | "security"
  | "workspace"
  | "customization"
  | "infrastructure"
  | "audit";

export type SettingsEntry = {
  id: SettingsPageID;
  path: `/settings/${string}`;
  group: "personal" | "workspace";
  labelKey: string;
  access?: {
    permission?: Permission;
    anyOf?: readonly Permission[];
    ownerOnly?: boolean;
  };
};

export const settingsRegistry = [
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
    id: "audit",
    path: "/settings/audit",
    group: "workspace",
    labelKey: "audit",
    access: { permission: "audit.read" },
  },
] as const satisfies readonly SettingsEntry[];

export function permissionsOf(user: User): ReadonlySet<Permission> {
  return new Set(user.permissions);
}

export function canAccessSettings(user: User, entry: SettingsEntry): boolean {
  if (user.role === "owner") return true;
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
  return settingsRegistry.filter((entry) => canAccessSettings(user, entry));
}

export function settingForPath(path: string): SettingsEntry | undefined {
  return settingsRegistry.find((entry) => entry.path === path);
}
