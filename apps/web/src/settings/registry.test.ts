import { describe, expect, it } from "vitest";
import type { Permission, User } from "@comamessenger/core";
import {
  canAccessSettings,
  canAccessSettingsPage,
  hasPermission,
  settingForPath,
  settingsRegistry,
  visibleChildSettings,
  visibleSettings,
} from "./registry";

function user(role: User["role"], permissions: Permission[] = []): User {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    org_id: "00000000-0000-4000-8000-000000000002",
    organization_name: "Coma",
    role,
    email: "user@example.test",
    display_name: "User",
    handle: "user",
    title: "",
    about: "",
    timezone: "UTC",
    status: "active",
    permissions,
    must_change_password: false,
    created_at: "2026-08-21T00:00:00Z",
  };
}

describe("settings registry", () => {
  it("registers notifications as a first-class route", () => {
    expect(settingForPath("/settings/notifications")?.id).toBe("notifications");
  });

  it("shows workspace settings only when permissions allow them", () => {
    expect(visibleSettings(user("admin")).map((entry) => entry.id)).toEqual([
      "profile",
      "notifications",
      "security",
    ]);
    expect(visibleSettings(user("member")).map((entry) => entry.id)).toEqual([
      "profile",
      "notifications",
      "security",
    ]);
  });

  it("uses explicit permissions when the contract supplies them", () => {
    const audit = settingsRegistry.find((entry) => entry.id === "audit")!;
    const infrastructure = settingsRegistry.find(
      (entry) => entry.id === "infrastructure",
    )!;
    const admin = user("admin", ["audit.read"]);
    expect(canAccessSettings(admin, audit)).toBe(true);
    expect(canAccessSettings(admin, infrastructure)).toBe(false);
    expect(canAccessSettingsPage(admin, "audit")).toBe(true);
    expect(canAccessSettingsPage(admin, "infrastructure")).toBe(false);
    expect(hasPermission(admin, "audit.read")).toBe(true);
    expect(hasPermission(admin, "members.manage")).toBe(false);
  });

  it("opens workspace navigation for any workspace permission", () => {
    expect(
      canAccessSettingsPage(user("admin", ["members.manage"]), "workspace"),
    ).toBe(true);
    expect(
      canAccessSettingsPage(user("admin", ["invitations.manage"]), "workspace"),
    ).toBe(true);
  });

  it("exposes only permitted workspace subpages", () => {
    const admin = user("admin", ["members.manage", "workspace.policies"]);
    expect(
      visibleChildSettings(admin, "workspace").map((entry) => entry.id),
    ).toEqual(["workspace-members", "workspace-policies"]);
    expect(canAccessSettingsPage(admin, "workspace-members")).toBe(true);
    expect(canAccessSettingsPage(admin, "workspace-general")).toBe(false);
  });

  it("registers workspace subpages as direct routes", () => {
    expect(settingForPath("/settings/workspace/general")?.id).toBe(
      "workspace-general",
    );
    expect(settingForPath("/settings/workspace/invitations")?.id).toBe(
      "workspace-invitations",
    );
  });
});
