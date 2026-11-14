import { APIError } from "./api";
import { hasPermission } from "./settings";
import type {
  InfrastructureSettings,
  OrganizationMember,
  OrganizationSettings,
  Permission,
  UpdateInfrastructureSettingsRequest,
  UpdateOrganizationSettingsRequest,
  User,
} from "./types";

/* ---------- Workspace settings ---------- */

/** The whole settings object goes back with every change, with its version. */
export function organizationUpdate(
  value: OrganizationSettings,
): UpdateOrganizationSettingsRequest {
  return {
    name: value.name,
    slug: value.slug,
    expected_version: value.version,
    invitation_default_role: value.invitation_default_role,
    invitation_ttl_hours: value.invitation_ttl_hours,
    default_timezone: value.default_timezone,
    allow_member_invitations: value.allow_member_invitations,
    allow_public_chat_creation: value.allow_public_chat_creation,
    allow_channel_creation: value.allow_channel_creation,
    accent_color: value.accent_color,
  };
}

/** Fields each settings page saves; the rest of the draft is not its business. */
export const organizationFields = {
  general: ["name", "slug", "default_timezone"],
  invitations: [
    "invitation_default_role",
    "invitation_ttl_hours",
    "allow_member_invitations",
  ],
  policies: ["allow_public_chat_creation", "allow_channel_creation"],
  branding: ["accent_color"],
} as const satisfies Record<string, readonly (keyof OrganizationSettings)[]>;

export function organizationFingerprint(
  fields: readonly (keyof OrganizationSettings)[],
) {
  return (value: OrganizationSettings) =>
    fields.length === 1
      ? String(value[fields[0]!])
      : JSON.stringify(
          Object.fromEntries(fields.map((field) => [field, value[field]])),
        );
}

/**
 * After a save: a draft changed again meanwhile keeps its edits and takes the
 * new version; otherwise the server's copy replaces it.
 */
export function reconcileOrganizationDraft(
  current: OrganizationSettings | null,
  updated: OrganizationSettings,
  snapshot: OrganizationSettings,
  fingerprint: (value: OrganizationSettings) => string,
): OrganizationSettings {
  return current && fingerprint(current) !== fingerprint(snapshot)
    ? { ...current, version: updated.version }
    : updated;
}

/* ---------- Validation (mirrors the contract) ---------- */

export type FieldError =
  | "required"
  | "tooLong"
  | "slug"
  | "ttl"
  | "hexColor"
  | "port"
  | "email"
  | "passwordTooShort"
  | "passwordsDoNotMatch"
  | "passwordUnchanged";

export const passwordMinLength = 10;
export const invitationTTLRange = { min: 1, max: 720 } as const;

const slugPattern = /^[a-z0-9][a-z0-9-]{1,62}$/;
const hexPattern = /^#[0-9A-Fa-f]{6}$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateWorkspaceGeneral(value: {
  name: string;
  slug: string;
  default_timezone: string;
}): Partial<Record<"name" | "slug" | "default_timezone", FieldError>> {
  const errors: Partial<
    Record<"name" | "slug" | "default_timezone", FieldError>
  > = {};
  if (!value.name.trim()) errors.name = "required";
  else if (value.name.length > 120) errors.name = "tooLong";
  if (!slugPattern.test(value.slug)) errors.slug = "slug";
  if (!value.default_timezone.trim()) errors.default_timezone = "required";
  else if (value.default_timezone.length > 64)
    errors.default_timezone = "tooLong";
  return errors;
}

export function validInvitationTTL(hours: number): boolean {
  return (
    Number.isInteger(hours) &&
    hours >= invitationTTLRange.min &&
    hours <= invitationTTLRange.max
  );
}

export function validHexColor(value: string): boolean {
  return hexPattern.test(value);
}

export function validEmail(value: string): boolean {
  return emailPattern.test(value.trim());
}

export function validPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/** «Change password»: what blocks the button, the first problem only. */
export function passwordChangeError(input: {
  current: string;
  next: string;
  confirm: string;
}): FieldError | null {
  if (!input.current) return "required";
  if (input.next.length < passwordMinLength) return "passwordTooShort";
  if (input.next !== input.confirm) return "passwordsDoNotMatch";
  if (input.next === input.current) return "passwordUnchanged";
  return null;
}

/** i18n key of a field error; the same keys on the web and the phone. */
export function fieldErrorKey(error: FieldError): string {
  return {
    required: "fieldRequired",
    tooLong: "fieldTooLong",
    slug: "fieldSlug",
    ttl: "fieldInvitationTTL",
    hexColor: "fieldHexColor",
    port: "fieldPort",
    email: "fieldEmail",
    passwordTooShort: "fieldPasswordTooShort",
    passwordsDoNotMatch: "passwordsDoNotMatch",
    passwordUnchanged: "fieldPasswordUnchanged",
  }[error];
}

/**
 * i18n key of a failed request, or null when it is not an API error (no
 * network, a bug): each app words that case itself.
 */
export function apiErrorKey(cause: unknown): string | null {
  if (!(cause instanceof APIError)) return null;
  switch (cause.code) {
    case "reauthentication_failed":
      return "errorWrongPassword";
    case "email_taken":
      return "errorEmailTaken";
    case "agent_not_ready":
      return "errorAgentNotReady";
    case "rate_limited":
      return "errorRateLimited";
    case "payload_too_large":
      return "errorTooLarge";
    case "unsupported_format":
      return "errorUnsupportedFormat";
  }
  if (cause.status === 401) return "errorUnauthorized";
  if (cause.status === 403) return "errorForbidden";
  if (cause.status === 409) return "errorConflict";
  if (cause.status === 422) return "errorValidation";
  return "error";
}

/* ---------- Members ---------- */

export type MemberRole = OrganizationMember["role"];

export function roleLabelKey(role: MemberRole | string): string {
  return role === "owner"
    ? "roleOwner"
    : role === "admin"
      ? "roleAdmin"
      : "roleMember";
}

/** Permissions a regular member may hold; the rest are administrators' only. */
export const memberGrantablePermissions: readonly Permission[] = [
  "knowledge.manage",
];

/**
 * What the current user may do with a workspace member. The server checks
 * the same: the owner changes only through ownership transfer, nobody
 * deactivates themselves, administrators manage regular members only.
 */
export function memberRules(
  actor: User,
  member: OrganizationMember,
  options: { passwordRecoveryAvailable?: boolean } = {},
) {
  const self = member.actor_id === actor.id;
  const owner = actor.role === "owner";
  const manageable =
    !self && member.role !== "owner" && (owner || member.role === "member");
  const active = member.status === "active";
  return {
    self,
    /** The role select is enabled. */
    canChangeRole: manageable,
    /** Roles the actor may assign; administrators keep members members. */
    assignableRoles: (owner ? ["admin", "member"] : ["member"]) as (
      | "admin"
      | "member"
    )[],
    canChangeStatus: manageable,
    canRequirePasswordChange: manageable && active,
    canSendPasswordReset:
      manageable && active && Boolean(options.passwordRecoveryAvailable),
    canChangeAvatar: true,
    /** The «knowledge base» switch is shown (regular members, not oneself). */
    showsKnowledgePermission: member.role === "member" && !self,
    canGrantKnowledge:
      (owner || hasPermission(actor, "knowledge.manage")) && active,
    /** Administrator permissions are shown and edited by the owner only. */
    showsAdminPermissions: member.role === "admin" && owner,
  };
}

export function withPermission(
  current: readonly Permission[],
  code: Permission,
  granted: boolean,
): Permission[] {
  const rest = current.filter((permission) => permission !== code);
  return granted ? [...rest, code] : rest;
}

/** Who may receive ownership: active, not the owner, not oneself. */
export function ownershipCandidates(
  actor: User,
  members: readonly OrganizationMember[],
): OrganizationMember[] {
  return members.filter(
    (member) =>
      member.actor_id !== actor.id &&
      member.status === "active" &&
      member.role !== "owner",
  );
}

export type MemberFilter = "all" | "admins" | "members" | "deactivated";

export const memberFilters: readonly MemberFilter[] = [
  "all",
  "admins",
  "members",
  "deactivated",
];

function matchesFilter(member: OrganizationMember, filter: MemberFilter) {
  switch (filter) {
    case "admins":
      return member.status === "active" && member.role !== "member";
    case "members":
      return member.status === "active" && member.role === "member";
    case "deactivated":
      return member.status !== "active";
    default:
      return true;
  }
}

/**
 * Members matching a search and a filter: the owner first, then
 * administrators, then members by name; deactivated ones last.
 */
export function filterMembers(
  members: readonly OrganizationMember[],
  { query, filter }: { query: string; filter: MemberFilter },
  locale?: string,
): OrganizationMember[] {
  const needle = query.trim().toLowerCase().replace(/^@/, "");
  const rank = { owner: 0, admin: 1, member: 2 } as const;
  return members
    .filter((member) => matchesFilter(member, filter))
    .filter(
      (member) =>
        !needle ||
        [member.display_name, member.handle, member.email, member.title].some(
          (field) => field.toLowerCase().includes(needle),
        ),
    )
    .sort(
      (a, b) =>
        Number(a.status !== "active") - Number(b.status !== "active") ||
        rank[a.role] - rank[b.role] ||
        a.display_name.localeCompare(b.display_name, locale),
    );
}

export function memberFilterCounts(
  members: readonly OrganizationMember[],
): Record<MemberFilter, number> {
  return Object.fromEntries(
    memberFilters.map((filter) => [
      filter,
      members.filter((member) => matchesFilter(member, filter)).length,
    ]),
  ) as Record<MemberFilter, number>;
}

/* ---------- Infrastructure ---------- */

export function normalizeInfrastructure(
  value: InfrastructureSettings,
): InfrastructureSettings {
  return {
    ...value,
    smtp: {
      ...value.smtp,
      security: value.smtp.security || "starttls",
      port: value.smtp.port || 587,
    },
  };
}

export function infrastructureFingerprint(value: InfrastructureSettings) {
  return JSON.stringify({
    s3: {
      endpoint: value.s3.endpoint,
      region: value.s3.region,
      bucket: value.s3.bucket,
      prefix: value.s3.prefix,
      force_path_style: value.s3.force_path_style,
    },
    smtp: {
      host: value.smtp.host,
      port: value.smtp.port,
      username: value.smtp.username,
      from_address: value.smtp.from_address,
      from_name: value.smtp.from_name,
      security: value.smtp.security,
    },
  });
}

/** Secrets typed into the form; empty means «keep the stored one». */
export type InfrastructureSecrets = {
  s3AccessKey: string;
  s3SecretKey: string;
  smtpPassword: string;
};

export function infrastructureDirty(
  value: InfrastructureSettings | null,
  baseline: InfrastructureSettings | null,
  secrets: InfrastructureSecrets,
): boolean {
  return Boolean(
    value &&
      baseline &&
      (infrastructureFingerprint(value) !==
        infrastructureFingerprint(baseline) ||
        secrets.s3AccessKey ||
        secrets.s3SecretKey ||
        secrets.smtpPassword),
  );
}

export function infrastructureUpdate(
  value: InfrastructureSettings,
  secrets: InfrastructureSecrets,
): UpdateInfrastructureSettingsRequest {
  return {
    expected_version: value.version,
    s3: {
      endpoint: value.s3.endpoint,
      region: value.s3.region,
      bucket: value.s3.bucket,
      prefix: value.s3.prefix,
      force_path_style: value.s3.force_path_style,
      access_key: secrets.s3AccessKey || null,
      secret_key: secrets.s3SecretKey || null,
      clear_credentials: false,
    },
    smtp: {
      host: value.smtp.host,
      port: value.smtp.port,
      username: value.smtp.username,
      password: secrets.smtpPassword || null,
      from_address: value.smtp.from_address,
      from_name: value.smtp.from_name,
      security: value.smtp.security,
      clear_credentials: false,
    },
  };
}

/* ---------- Personal ---------- */

/** Time zones offered in the profile; the user's own one is kept if absent. */
export const commonTimezones = [
  "UTC",
  "Europe/Kaliningrad",
  "Europe/Moscow",
  "Europe/Samara",
  "Asia/Yekaterinburg",
  "Asia/Omsk",
  "Asia/Novosibirsk",
  "Asia/Irkutsk",
  "Asia/Yakutsk",
  "Asia/Vladivostok",
  "Asia/Magadan",
  "Asia/Kamchatka",
] as const;

export function timezoneOptions(current: string): string[] {
  return (commonTimezones as readonly string[]).includes(current)
    ? [...commonTimezones]
    : [current, ...commonTimezones];
}

/** Audit categories the server groups events by. */
export const auditCategories = [
  "organization",
  "members",
  "invitations",
  "security",
  "chats",
  "infrastructure",
  "agents",
] as const;
