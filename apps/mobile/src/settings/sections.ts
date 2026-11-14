import {
  Bell,
  Building2,
  History,
  KeyRound,
  Mail,
  MonitorSmartphone,
  Palette,
  Paintbrush,
  PlugZap,
  ShieldCheck,
  SlidersHorizontal,
  UserPlus,
  UserRound,
  Users,
  type LucideIcon,
} from "lucide-react-native";
import {
  canAccessSettingsPage,
  type SettingsPageID,
  type User,
} from "@comamessenger/core";

export type SettingsLink = {
  id: string;
  href: string;
  labelKey: string;
  hintKey?: string;
  icon: LucideIcon;
};

/** Personal pages: open to everyone. */
export const personalLinks: SettingsLink[] = [
  {
    id: "profile",
    href: "/settings/profile",
    labelKey: "profile",
    icon: UserRound,
  },
  {
    id: "notifications",
    href: "/settings/notifications",
    labelKey: "settingsNotifications",
    icon: Bell,
  },
  {
    id: "appearance",
    href: "/settings/appearance",
    labelKey: "appearanceAndLanguage",
    icon: Palette,
  },
];

/** The «Security» page of the web, split into its three forms. */
export const securityLinks: SettingsLink[] = [
  {
    id: "password",
    href: "/settings/password",
    labelKey: "changePassword",
    icon: KeyRound,
  },
  {
    id: "email",
    href: "/settings/email",
    labelKey: "changeEmail",
    icon: Mail,
  },
  {
    id: "sessions",
    href: "/settings/sessions",
    labelKey: "sessions",
    icon: MonitorSmartphone,
  },
];

/** Workspace pages, in the web's order; ids are the shared registry's. */
const workspacePages: (SettingsLink & { id: SettingsPageID })[] = [
  {
    id: "workspace",
    href: "/settings/workspace",
    labelKey: "workspaceOverview",
    icon: Building2,
  },
  {
    id: "workspace-general",
    href: "/settings/workspace/general",
    labelKey: "workspaceGeneral",
    hintKey: "workspaceGeneralHint",
    icon: SlidersHorizontal,
  },
  {
    id: "workspace-members",
    href: "/settings/workspace/members",
    labelKey: "membersAndRoles",
    hintKey: "membersAccessHint",
    icon: Users,
  },
  {
    id: "workspace-invitations",
    href: "/settings/workspace/invitations",
    labelKey: "invitations",
    hintKey: "invitationPolicyHint",
    icon: UserPlus,
  },
  {
    id: "workspace-policies",
    href: "/settings/workspace/policies",
    labelKey: "creationPolicy",
    hintKey: "creationPolicyHint",
    icon: ShieldCheck,
  },
  {
    id: "customization",
    href: "/settings/customization",
    labelKey: "branding",
    hintKey: "brandingHint",
    icon: Paintbrush,
  },
  {
    id: "infrastructure",
    href: "/settings/infrastructure",
    labelKey: "connections",
    hintKey: "connectionsHint",
    icon: PlugZap,
  },
  {
    id: "audit",
    href: "/settings/audit",
    labelKey: "auditLog",
    hintKey: "auditLogHint",
    icon: History,
  },
];

const workspaceChildren = new Set<SettingsPageID>([
  "workspace-general",
  "workspace-members",
  "workspace-invitations",
  "workspace-policies",
]);

/** Workspace pages this user may open; empty hides the whole section. */
export function workspaceLinks(user: User) {
  return workspacePages.filter((page) => canAccessSettingsPage(user, page.id));
}

/** The pages listed on the workspace overview (the web's sub-navigation). */
export function workspaceOverviewLinks(user: User) {
  return workspaceLinks(user).filter((page) => workspaceChildren.has(page.id));
}
