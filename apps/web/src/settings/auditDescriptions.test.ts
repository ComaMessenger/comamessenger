import { describe, expect, it } from "vitest";
import {
  auditActions,
  describeAudit,
  type AuditEntry,
} from "./auditDescriptions";

describe("audit descriptions", () => {
  it("describes every server audit action in Russian and English", () => {
    for (const action of auditActions) {
      const entry = {
        id: "00000000-0000-4000-8000-000000000001",
        actor_id: null,
        actor_name: "Ada",
        actor_role: "admin",
        action,
        category: "organization",
        target_type: "organization",
        target_id: null,
        target_name: "Coma",
        metadata: {},
        changes: {},
        created_at: "2026-08-21T00:00:00Z",
      } as AuditEntry;
      expect(describeAudit(entry, "ru")).not.toContain(action);
      expect(describeAudit(entry, "en")).not.toContain(action);
    }
  });

  it("translates agent creation instead of exposing the action code", () => {
    const entry = {
      id: "00000000-0000-4000-8000-000000000001",
      actor_id: "00000000-0000-4000-8000-000000000002",
      actor_name: "Лев Павлов",
      actor_role: "owner",
      action: "agent.create",
      category: "agents",
      target_type: "agent",
      target_id: "00000000-0000-4000-8000-000000000003",
      target_name: "Помощник",
      metadata: {},
      changes: {},
      created_at: "2026-08-21T00:00:00Z",
    } as AuditEntry;
    expect(describeAudit(entry, "ru")).toBe(
      "Лев Павлов создал(а) агента Помощник",
    );
  });
});
