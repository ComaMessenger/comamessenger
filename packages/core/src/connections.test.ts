import { describe, expect, it } from "vitest";
import { APIError } from "./api";
import type {
  AgentLlmConnection,
  McpConnection,
  Permission,
  User,
} from "./types";
import {
  connectionErrorKey,
  connectionRequestErrorKey,
  connectionsAccess,
  createLlmConnectionRequest,
  createMcpConnectionRequest,
  emptyLlmConnectionDraft,
  emptyMcpConnectionDraft,
  endpointOrigin,
  isInternalHost,
  isMcpToolAssignable,
  llmConnectionDraftReady,
  llmConnectionEdit,
  llmConnectionEditReady,
  llmEndpointProblem,
  maskSecret,
  mcpConnectionDraftReady,
  mcpConnectionEdit,
  mcpConnectionEditReady,
  mcpEditDropsSecret,
  mcpEndpointProblem,
  toggledAssignableTools,
  updateLlmConnectionRequest,
  updateMcpConnectionRequest,
  validWebhookRate,
  webhookURL,
  withProvider,
} from "./connections";

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
    can_create_invitations: false,
    status_emoji: "",
    status_text: "",
    status_expires_at: null,
    avatar_version: 0,
    created_at: "2026-08-21T00:00:00Z",
  };
}

const llm: AgentLlmConnection = {
  id: "c1",
  name: "Gateway",
  provider: "openai-compatible",
  endpoint_url: "https://api.example.test/v1",
  default_model: "gpt-4o-mini",
  enabled: true,
  key_hint: "sk-…abcd",
  health_status: "healthy",
  last_tested_at: null,
  last_error_code: "",
  embedding_model: "",
  embedding_data_sharing_approved: false,
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
};

const mcp: McpConnection = {
  id: "m1",
  name: "accounting",
  description: "Учёт",
  endpoint_url: "https://mcp.example.test/mcp",
  enabled: true,
  allow_private_network: false,
  headers_configured: true,
  secret_hint: "Authorization: ••••abcd",
  timeout_ms: 10000,
  max_output_bytes: 262144,
  agent_use_allowed: false,
  writes_require_confirmation: true,
  assignable_tools: null,
  tools: [
    { name: "slots", description: "", read_only: true },
    { name: "assign", description: "", read_only: false },
  ],
  tools_refreshed_at: null,
  health_status: "healthy",
  last_tested_at: null,
  last_error_code: "",
  agent_count: 0,
  created_by: "u1",
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
};

describe("connections access", () => {
  it("follows the server: integrations.manage manages, agents.* only looks", () => {
    expect(connectionsAccess(user("owner"))).toEqual({
      manage: true,
      viewModels: true,
      viewIntegrations: true,
    });
    expect(connectionsAccess(user("admin", ["integrations.manage"]))).toEqual({
      manage: true,
      viewModels: true,
      viewIntegrations: true,
    });
    expect(connectionsAccess(user("admin", ["agents.manage"]))).toEqual({
      manage: false,
      viewModels: true,
      viewIntegrations: true,
    });
    expect(connectionsAccess(user("member", ["agents.build"]))).toEqual({
      manage: false,
      viewModels: false,
      viewIntegrations: true,
    });
    expect(connectionsAccess(user("admin"))).toEqual({
      manage: false,
      viewModels: false,
      viewIntegrations: false,
    });
  });
});

describe("addresses", () => {
  it("checks a provider address like the server", () => {
    expect(llmEndpointProblem("")).toBe("required");
    expect(llmEndpointProblem("api.example.test")).toBe("invalid");
    expect(llmEndpointProblem("ftp://api.example.test")).toBe("scheme");
    expect(llmEndpointProblem("https://user:pw@api.example.test")).toBe(
      "credentials",
    );
    expect(llmEndpointProblem("https://api.example.test/v1#x")).toBe(
      "credentials",
    );
    expect(llmEndpointProblem(" https://api.provod.ai/v1 ")).toBeNull();
    expect(llmEndpointProblem("http://localhost:11434/v1")).toBeNull();
  });

  it("hints at internal systems and refuses cloud metadata", () => {
    expect(
      mcpEndpointProblem("https://mcp.example.test/mcp", false),
    ).toBeNull();
    expect(mcpEndpointProblem("http://mcp.example.test/mcp", false)).toBe(
      "internal",
    );
    expect(mcpEndpointProblem("https://10.0.0.5/mcp", false)).toBe("internal");
    expect(mcpEndpointProblem("https://crm.local/mcp", false)).toBe("internal");
    expect(mcpEndpointProblem("https://10.0.0.5/mcp", true)).toBeNull();
    expect(mcpEndpointProblem("http://169.254.169.254/latest", true)).toBe(
      "metadata",
    );
    expect(mcpEndpointProblem("http://metadata.google.internal/", true)).toBe(
      "metadata",
    );
  });

  it("knows internal hosts", () => {
    for (const host of [
      "localhost",
      "192.168.1.2",
      "172.20.0.1",
      "::1",
      "fd12:3::1",
      "crm",
    ])
      expect(isInternalHost(host)).toBe(true);
    for (const host of ["8.8.8.8", "api.example.test", "2001:db8::1"])
      expect(isInternalHost(host)).toBe(false);
  });

  it("compares origins with default ports", () => {
    expect(endpointOrigin("https://A.example.test/mcp")).toBe(
      endpointOrigin("https://a.example.test:443/other"),
    );
    expect(endpointOrigin("https://a.example.test/mcp")).not.toBe(
      endpointOrigin("http://a.example.test/mcp"),
    );
  });
});

describe("secrets", () => {
  it("never shows more than the ends", () => {
    expect(maskSecret("sk-proj-abcdefghijklmnop1234")).toBe("sk-…1234");
    expect(maskSecret("whsec_0123456789abcdef")).toBe("whsec_…cdef");
    expect(maskSecret("0123456789abcdefXYZW")).toBe("…XYZW");
    expect(maskSecret("short")).toBe("••••");
  });
});

describe("model connections", () => {
  it("is ready with a name, a key and an address when one is needed", () => {
    const draft = { ...emptyLlmConnectionDraft, name: "OpenAI", api_key: "sk" };
    expect(llmConnectionDraftReady(draft)).toBe(true);
    const compatible = withProvider(draft, "openai-compatible");
    expect(llmConnectionDraftReady(compatible)).toBe(false);
    expect(
      llmConnectionDraftReady({ ...compatible, endpoint_url: "http://x/v1" }),
    ).toBe(true);
    expect(
      withProvider({ ...compatible, endpoint_url: "http://x/v1" }, "openai")
        .endpoint_url,
    ).toBe("");
  });

  it("creates enabled connections", () => {
    expect(
      createLlmConnectionRequest({ ...emptyLlmConnectionDraft, name: "A" }),
    ).toMatchObject({ name: "A", enabled: true });
  });

  it("sends only what changed, and the key only when typed", () => {
    const edit = llmConnectionEdit(llm);
    expect(edit.api_key).toBe("");
    expect(updateLlmConnectionRequest(llm, edit)).toBeNull();
    expect(
      updateLlmConnectionRequest(llm, {
        ...edit,
        default_model: " gpt-4.1 ",
        api_key: "  sk-new  ",
      }),
    ).toEqual({ default_model: "gpt-4.1", api_key: "sk-new" });
    expect(
      updateLlmConnectionRequest(llm, {
        ...edit,
        embedding_model: "text-embedding-3-small",
        embedding_data_sharing_approved: true,
      }),
    ).toEqual({
      embedding_model: "text-embedding-3-small",
      embedding_data_sharing_approved: true,
    });
    expect(
      updateLlmConnectionRequest(llm, { ...edit, provider: "anthropic" }),
    ).toEqual({ provider: "anthropic", endpoint_url: "" });
    expect(llmConnectionEditReady({ ...edit, endpoint_url: "x" })).toBe(false);
    expect(llmConnectionEditReady(edit)).toBe(true);
  });
});

describe("MCP connections", () => {
  it("builds the web's create request", () => {
    const draft = {
      ...emptyMcpConnectionDraft,
      name: " crm ",
      endpoint_url: " https://mcp.example.test ",
      header_value: " Bearer x ",
    };
    expect(mcpConnectionDraftReady(draft)).toBe(true);
    expect(mcpConnectionDraftReady({ ...draft, name: "CRM" })).toBe(false);
    expect(createMcpConnectionRequest(draft)).toEqual({
      name: "crm",
      description: "",
      endpoint_url: "https://mcp.example.test",
      enabled: true,
      allow_private_network: false,
      agent_use_allowed: false,
      writes_require_confirmation: true,
      headers: { Authorization: "Bearer x" },
    });
    expect(
      createMcpConnectionRequest({ ...draft, header_value: "" }),
    ).not.toHaveProperty("headers");
  });

  it("switches tools one by one", () => {
    expect(isMcpToolAssignable(mcp, "assign")).toBe(true);
    const next = toggledAssignableTools(mcp, "assign", false);
    expect(next).toEqual(["slots"]);
    const narrowed = { ...mcp, assignable_tools: next };
    expect(isMcpToolAssignable(narrowed, "assign")).toBe(false);
    expect(toggledAssignableTools(narrowed, "assign", true)).toEqual([
      "slots",
      "assign",
    ]);
  });

  it("edits the address, headers and limits", () => {
    const edit = mcpConnectionEdit(mcp);
    expect(updateMcpConnectionRequest(mcp, edit)).toBeNull();
    expect(mcpConnectionEditReady(edit)).toBe(true);
    const moved = { ...edit, endpoint_url: "https://other.example.test/mcp" };
    expect(mcpEditDropsSecret(mcp, moved)).toBe(true);
    expect(
      mcpEditDropsSecret(mcp, {
        ...edit,
        endpoint_url: "https://mcp.example.test/v2",
      }),
    ).toBe(false);
    expect(
      updateMcpConnectionRequest(mcp, {
        ...moved,
        replace_headers: true,
        header_value: "Bearer y",
      }),
    ).toEqual({
      endpoint_url: "https://other.example.test/mcp",
      headers: { Authorization: "Bearer y" },
    });
    expect(
      updateMcpConnectionRequest(mcp, { ...edit, replace_headers: true }),
    ).toEqual({ headers: {} });
    expect(mcpConnectionEditReady({ ...edit, timeout_ms: 50 })).toBe(false);
  });
});

describe("webhooks", () => {
  it("builds the public address from the API origin", () => {
    expect(webhookURL("http://localhost:8080", "a b")).toBe(
      "http://localhost:8080/api/v1/hooks/a%20b",
    );
    expect(webhookURL("https://chat.example.test/base/", "id")).toBe(
      new URL("/api/v1/hooks/id", "https://chat.example.test/base/").toString(),
    );
  });

  it("limits the request rate", () => {
    expect(validWebhookRate(60)).toBe(true);
    expect(validWebhookRate(0)).toBe(false);
    expect(validWebhookRate(6001)).toBe(false);
    expect(validWebhookRate(1.5)).toBe(false);
  });
});

describe("errors", () => {
  it("names stored health errors", () => {
    expect(connectionErrorKey("unauthorized")).toBe(
      "connectionErrorUnauthorized",
    );
    expect(connectionErrorKey("mcp_endpoint_forbidden")).toBe(
      "connectionErrorEndpointForbidden",
    );
    expect(connectionErrorKey("something_new")).toBe("connectionErrorUnknown");
  });

  it("explains refusals the administrator can act on", () => {
    expect(
      connectionRequestErrorKey(
        new APIError(409, "integration_in_use", "x"),
        "mcp",
      ),
    ).toBe("mcpConnectionInUse");
    expect(
      connectionRequestErrorKey(new APIError(409, "conflict", "x"), "model"),
    ).toBe("modelConnectionInUse");
    expect(
      connectionRequestErrorKey(
        new APIError(
          422,
          "validation_failed",
          "invalid: internal address is not in INTEGRATIONS_ALLOWED_PRIVATE_TARGETS",
        ),
        "mcp",
      ),
    ).toBe("mcpPrivateTargetNotAllowed");
    expect(
      connectionRequestErrorKey(
        new APIError(409, "integration_usage_changed", "x"),
        "mcp",
      ),
    ).toBe("connectionUsageChanged");
    expect(connectionRequestErrorKey(new Error("offline"), "mcp")).toBeNull();
  });
});
