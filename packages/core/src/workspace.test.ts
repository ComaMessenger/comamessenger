import { describe, expect, it } from "vitest";
import { APIError } from "./api";
import {
  apiErrorKey,
  filterMembers,
  comaMailStateKey,
  comaMailUsage,
  infrastructureDirty,
  mailDeliveryProblem,
  infrastructureUpdate,
  memberFilterCounts,
  memberRules,
  normalizeInfrastructure,
  organizationFingerprint,
  organizationFields,
  organizationUpdate,
  ownershipCandidates,
  passwordChangeError,
  reconcileOrganizationDraft,
  timezoneOptions,
  validateWorkspaceGeneral,
  validHexColor,
  validInvitationTTL,
  withPermission,
} from "./workspace";
import type {
  InfrastructureSettings,
  OrganizationMember,
  OrganizationSettings,
  Permission,
  User,
} from "./types";

function user(role: User["role"], permissions: Permission[] = []): User {
  return {
    id: "me",
    org_id: "org",
    organization_name: "Coma",
    role,
    email: "me@example.test",
    display_name: "Me",
    handle: "me",
    title: "",
    about: "",
    timezone: "UTC",
    status: "active",
    permissions,
    must_change_password: false,
    can_create_invitations: role === "owner",
    status_emoji: "",
    status_text: "",
    status_expires_at: null,
    avatar_version: 0,
    created_at: "2026-08-21T00:00:00Z",
  };
}

function member(
  id: string,
  role: OrganizationMember["role"],
  extra: Partial<OrganizationMember> = {},
): OrganizationMember {
  return {
    actor_id: id,
    email: `${id}@example.test`,
    display_name: id[0]!.toUpperCase() + id.slice(1),
    handle: id,
    title: "",
    role,
    status: "active",
    permissions: [],
    created_at: "2026-08-21T00:00:00Z",
    last_seen_at: null,
    status_emoji: "",
    status_text: "",
    status_expires_at: null,
    avatar_version: 0,
    ...extra,
  };
}

const settings: OrganizationSettings = {
  id: "org",
  name: "Coma",
  slug: "coma",
  version: 3,
  invitation_default_role: "member",
  invitation_ttl_hours: 72,
  default_timezone: "Europe/Moscow",
  allow_member_invitations: true,
  allow_public_chat_creation: true,
  allow_channel_creation: false,
  accent_color: "#174586",
  has_logo: false,
  has_favicon: false,
};

describe("organization settings", () => {
  it("sends every field with the expected version", () => {
    expect(organizationUpdate(settings)).toMatchObject({
      expected_version: 3,
      name: "Coma",
      accent_color: "#174586",
    });
  });

  it("fingerprints only the page's own fields", () => {
    const general = organizationFingerprint(organizationFields.general);
    expect(general({ ...settings, allow_channel_creation: true })).toBe(
      general(settings),
    );
    expect(general({ ...settings, name: "X" })).not.toBe(general(settings));
    expect(organizationFingerprint(organizationFields.branding)(settings)).toBe(
      "#174586",
    );
  });

  it("keeps edits made during a save and takes the new version", () => {
    const fingerprint = organizationFingerprint(organizationFields.general);
    const snapshot = { ...settings, name: "A" };
    const updated = { ...snapshot, version: 4 };
    expect(
      reconcileOrganizationDraft(
        { ...settings, name: "AB" },
        updated,
        snapshot,
        fingerprint,
      ),
    ).toMatchObject({ name: "AB", version: 4 });
    expect(
      reconcileOrganizationDraft(snapshot, updated, snapshot, fingerprint),
    ).toBe(updated);
  });

  it("validates like the contract", () => {
    expect(validateWorkspaceGeneral(settings)).toEqual({});
    expect(
      validateWorkspaceGeneral({ ...settings, name: " ", slug: "Bad slug" }),
    ).toEqual({ name: "required", slug: "slug" });
    expect(validInvitationTTL(0)).toBe(false);
    expect(validInvitationTTL(720)).toBe(true);
    expect(validInvitationTTL(1.5)).toBe(false);
    expect(validHexColor("#AABBCC")).toBe(true);
    expect(validHexColor("#ABC")).toBe(false);
  });
});

describe("password change", () => {
  it("names the first problem", () => {
    expect(passwordChangeError({ current: "", next: "", confirm: "" })).toBe(
      "required",
    );
    expect(
      passwordChangeError({ current: "a", next: "short", confirm: "short" }),
    ).toBe("passwordTooShort");
    expect(
      passwordChangeError({
        current: "a",
        next: "long enough 1",
        confirm: "long enough 2",
      }),
    ).toBe("passwordsDoNotMatch");
    expect(
      passwordChangeError({
        current: "same password",
        next: "same password",
        confirm: "same password",
      }),
    ).toBe("passwordUnchanged");
    expect(
      passwordChangeError({
        current: "old",
        next: "new password",
        confirm: "new password",
      }),
    ).toBeNull();
  });
});

describe("apiErrorKey", () => {
  it("maps codes before statuses", () => {
    expect(apiErrorKey(new APIError(403, "reauthentication_failed", ""))).toBe(
      "errorWrongPassword",
    );
    expect(apiErrorKey(new APIError(409, "email_taken", ""))).toBe(
      "errorEmailTaken",
    );
    expect(apiErrorKey(new APIError(409, "version_conflict", ""))).toBe(
      "errorConflict",
    );
    expect(apiErrorKey(new APIError(403, "forbidden", ""))).toBe(
      "errorForbidden",
    );
    expect(apiErrorKey(new Error("offline"))).toBeNull();
  });
});

describe("member rules", () => {
  it("lets the owner manage administrators but not themselves", () => {
    const owner = user("owner");
    const rules = memberRules(owner, member("ann", "admin"), {
      passwordRecoveryAvailable: true,
    });
    expect(rules.canChangeRole).toBe(true);
    expect(rules.assignableRoles).toEqual(["admin", "member"]);
    expect(rules.canChangeStatus).toBe(true);
    expect(rules.canSendPasswordReset).toBe(true);
    expect(rules.showsAdminPermissions).toBe(true);
    const self = memberRules(owner, member("me", "owner"));
    expect(self.canChangeRole).toBe(false);
    expect(self.canChangeStatus).toBe(false);
    expect(self.canRequirePasswordChange).toBe(false);
  });

  it("keeps administrators to regular members", () => {
    const admin = user("admin", ["members.manage"]);
    expect(memberRules(admin, member("bob", "admin")).canChangeStatus).toBe(
      false,
    );
    expect(memberRules(admin, member("own", "owner")).canChangeStatus).toBe(
      false,
    );
    const regular = memberRules(admin, member("cat", "member"));
    expect(regular.canChangeStatus).toBe(true);
    expect(regular.assignableRoles).toEqual(["member"]);
    expect(regular.canGrantKnowledge).toBe(false);
    expect(regular.showsAdminPermissions).toBe(false);
    expect(
      memberRules(
        user("admin", ["members.manage", "knowledge.manage"]),
        member("cat", "member"),
      ).canGrantKnowledge,
    ).toBe(true);
  });

  it("does not require a password change from a deactivated member", () => {
    const rules = memberRules(
      user("owner"),
      member("dan", "member", { status: "deactivated" }),
    );
    expect(rules.canRequirePasswordChange).toBe(false);
    expect(rules.canGrantKnowledge).toBe(false);
  });

  it("toggles one permission", () => {
    expect(withPermission(["audit.read"], "knowledge.manage", true)).toEqual([
      "audit.read",
      "knowledge.manage",
    ]);
    expect(
      withPermission(["knowledge.manage"], "knowledge.manage", false),
    ).toEqual([]);
  });

  it("offers ownership to active non-owners other than oneself", () => {
    const list = [
      member("me", "owner"),
      member("ann", "admin"),
      member("off", "member", { status: "deactivated" }),
    ];
    expect(
      ownershipCandidates(user("owner"), list).map((m) => m.actor_id),
    ).toEqual(["ann"]);
  });
});

describe("filterMembers", () => {
  const list = [
    member("zoe", "member"),
    member("off", "admin", { status: "deactivated" }),
    member("ann", "admin", { title: "Designer" }),
    member("me", "owner"),
  ];

  it("orders owner, administrators, members, then deactivated", () => {
    expect(
      filterMembers(list, { query: "", filter: "all" }).map((m) => m.actor_id),
    ).toEqual(["me", "ann", "zoe", "off"]);
  });

  it("searches name, handle, email and title", () => {
    expect(
      filterMembers(list, { query: "design", filter: "all" }).map(
        (m) => m.actor_id,
      ),
    ).toEqual(["ann"]);
    expect(
      filterMembers(list, { query: "@zo", filter: "all" }).map(
        (m) => m.actor_id,
      ),
    ).toEqual(["zoe"]);
  });

  it("filters and counts", () => {
    expect(
      filterMembers(list, { query: "", filter: "admins" }).map(
        (m) => m.actor_id,
      ),
    ).toEqual(["me", "ann"]);
    expect(memberFilterCounts(list)).toEqual({
      all: 4,
      admins: 2,
      members: 1,
      deactivated: 1,
    });
  });
});

describe("infrastructure", () => {
  const value: InfrastructureSettings = normalizeInfrastructure({
    version: 2,
    s3: {
      endpoint: "",
      region: "",
      bucket: "",
      prefix: "",
      force_path_style: false,
      credentials_configured: false,
      access_key_hint: "",
    },
    smtp: {
      host: "",
      port: 0,
      username: "",
      from_address: "",
      from_name: "",
      security: "" as never,
      credentials_configured: false,
    },
  } as InfrastructureSettings);
  const none = { s3AccessKey: "", s3SecretKey: "", smtpPassword: "" };

  it("fills SMTP defaults", () => {
    expect(value.smtp).toMatchObject({ port: 587, security: "starttls" });
  });

  it("is dirty on a field or a typed secret", () => {
    expect(infrastructureDirty(value, value, none)).toBe(false);
    expect(
      infrastructureDirty(
        { ...value, s3: { ...value.s3, bucket: "b" } },
        value,
        none,
      ),
    ).toBe(true);
    expect(
      infrastructureDirty(value, value, { ...none, smtpPassword: "x" }),
    ).toBe(true);
  });

  it("keeps stored secrets unless new ones are typed", () => {
    const request = infrastructureUpdate(value, { ...none, s3SecretKey: "s" });
    expect(request.s3.access_key).toBeNull();
    expect(request.s3.secret_key).toBe("s");
    expect(request.smtp.password).toBeNull();
    expect(request.expected_version).toBe(2);
  });
});

describe("mail delivery", () => {
  const base = normalizeInfrastructure({
    version: 1,
    s3: {
      endpoint: "",
      region: "",
      bucket: "",
      prefix: "",
      force_path_style: false,
      credentials_configured: false,
    },
    smtp: {
      host: "",
      port: 587,
      username: "",
      from_address: "",
      from_name: "",
      security: "starttls",
      credentials_configured: false,
    },
    mail: {
      delivery: "coma",
      coma: {
        state: "active",
        used: 12,
        daily_limit: 100,
        per_recipient_limit: 6,
      },
    },
  });
  const none = { s3AccessKey: "", s3SecretKey: "", smtpPassword: "" };

  it("sends the chosen delivery and marks the form dirty", () => {
    const smtp = { ...base, mail: { delivery: "smtp" as const } };
    expect(infrastructureDirty(smtp, base, none)).toBe(true);
    expect(infrastructureUpdate(smtp, none).mail_delivery).toBe("smtp");
  });

  it("requires an SMTP host for own SMTP", () => {
    expect(mailDeliveryProblem(base)).toBeNull();
    expect(mailDeliveryProblem({ ...base, mail: { delivery: "smtp" } })).toBe(
      "smtpHostRequired",
    );
  });

  it("reports the daily spend only for active Coma mail", () => {
    expect(comaMailUsage(base.mail.coma)).toEqual({
      used: 12,
      limit: 100,
      percent: 12,
      perRecipient: 6,
      exhausted: false,
    });
    expect(
      comaMailUsage({ state: "registering", per_recipient_limit: 6 }),
    ).toBeNull();
    expect(
      comaMailUsage({
        state: "active",
        used: 120,
        daily_limit: 100,
        per_recipient_limit: 6,
      })?.exhausted,
    ).toBe(true);
  });

  it("names the state", () => {
    expect(comaMailStateKey(base.mail.coma)).toBe("comaMailStateActive");
    expect(
      comaMailStateKey({
        state: "unavailable",
        reason: "public_https_required",
        per_recipient_limit: 6,
      }),
    ).toBe("comaMailStateNeedsHttps");
  });

  it("defaults old responses to SMTP when a host is stored", () => {
    const legacy = normalizeInfrastructure({
      ...base,
      smtp: { ...base.smtp, host: "smtp.example.com" },
      mail: undefined as never,
    });
    expect(legacy.mail.delivery).toBe("smtp");
  });
});

it("keeps an unusual time zone in the options", () => {
  expect(timezoneOptions("Europe/Moscow")[0]).toBe("UTC");
  expect(timezoneOptions("America/Lima")[0]).toBe("America/Lima");
});
