import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  IntegrationWebhook,
  McpConnection,
  MessengerAPI,
} from "@comamessenger/core";
import { setLocale } from "../../i18n";
import { IntegrationsSection } from "./IntegrationsSection";

const connection: McpConnection = {
  id: "01900000-0000-7000-8000-000000000101",
  name: "accounting",
  description: "Fictional accounting",
  endpoint_url: "http://10.0.0.5:8080/mcp",
  enabled: true,
  allow_private_network: true,
  headers_configured: true,
  secret_hint: "Authorization: Bear••••3f9a",
  timeout_ms: 10000,
  max_output_bytes: 262144,
  agent_use_allowed: true,
  writes_require_confirmation: true,
  assignable_tools: null,
  tools: [
    { name: "get_slots", description: "Slots", read_only: true },
    { name: "assign_instructor", description: "Assign", read_only: false },
  ],
  tools_refreshed_at: "2026-11-10T10:00:00Z",
  health_status: "healthy",
  last_tested_at: "2026-11-10T10:00:00Z",
  last_error_code: "",
  agent_count: 1,
  created_by: "01900000-0000-7000-8000-000000000001",
  created_at: "2026-11-10T10:00:00Z",
  updated_at: "2026-11-10T10:00:00Z",
};

const hook: IntegrationWebhook = {
  id: "01900000-0000-7000-8000-000000000201",
  name: "Slots",
  description: "",
  enabled: true,
  secret_hint: "whsec_••••abcd",
  rate_limit_per_minute: 60,
  max_body_bytes: 65536,
  last_received_at: null,
  rejected_count: 0,
  last_rejected_at: null,
  last_rejected_code: "",
  trigger_count: 0,
  created_by: "01900000-0000-7000-8000-000000000001",
  created_at: "2026-11-10T10:00:00Z",
  updated_at: "2026-11-10T10:00:00Z",
};

function renderSection(api: Partial<MessengerAPI>, canManage = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <IntegrationsSection api={api as MessengerAPI} canManage={canManage} />
    </QueryClientProvider>,
  );
}

describe("workspace integrations", () => {
  beforeAll(async () => {
    await setLocale("en");
  });
  afterEach(cleanup);

  it("shows tools and masked secrets, and detaches only after the impact is confirmed", async () => {
    const detach = vi.fn().mockResolvedValue([]);
    const api = {
      apiURL: "https://coma.example.com",
      mcpConnections: vi.fn().mockResolvedValue([connection]),
      integrationWebhooks: vi.fn().mockResolvedValue([]),
      mcpConnectionUsage: vi.fn().mockResolvedValue([
        {
          agent_id: "01900000-0000-7000-8000-000000000301",
          display_name: "Slots agent",
          published: true,
          draft: true,
          allowed_tools: ["get_slots"],
        },
      ]),
      detachMcpConnection: detach,
    };
    renderSection(api);
    const card = await screen.findByTestId("mcp-connection");
    expect(within(card).getByText("get_slots")).toBeVisible();
    expect(within(card).getByText("changes data")).toBeVisible();
    expect(within(card).getByText("Authorization: Bear••••3f9a")).toBeVisible();
    // A used connection offers detaching instead of deleting.
    expect(within(card).queryByRole("button", { name: "Delete" })).toBeNull();
    fireEvent.click(
      within(card).getByRole("button", { name: "Detach from agents" }),
    );
    expect(await screen.findByText("Slots agent")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Detach from 1 agent" }),
    );
    await waitFor(() =>
      expect(detach).toHaveBeenCalledWith(connection.id, [
        "01900000-0000-7000-8000-000000000301",
      ]),
    );
  });

  it("creates connections closed for agents with approval for changes, and narrows assignable tools", async () => {
    const create = vi.fn().mockResolvedValue(connection);
    const update = vi.fn().mockResolvedValue(connection);
    const api = {
      apiURL: "",
      mcpConnections: vi.fn().mockResolvedValue([connection]),
      integrationWebhooks: vi.fn().mockResolvedValue([]),
      createMcpConnection: create,
      updateMcpConnection: update,
    };
    renderSection(api);
    const card = await screen.findByTestId("mcp-connection");
    fireEvent.click(
      within(card).getByRole("switch", {
        name: "May be given to agents: assign_instructor",
      }),
    );
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(connection.id, {
        assignable_tools: ["get_slots"],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect a system" }));
    fireEvent.change(screen.getByLabelText("Short name"), {
      target: { value: "erp" },
    });
    fireEvent.change(screen.getByLabelText("MCP server address"), {
      target: { value: "https://erp.example.com/mcp" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "erp",
          agent_use_allowed: false,
          writes_require_confirmation: true,
        }),
      ),
    );
  });

  it("shows a new webhook secret once with the signing address", async () => {
    let hooks: IntegrationWebhook[] = [];
    const api = {
      apiURL: "https://coma.example.com",
      mcpConnections: vi.fn().mockResolvedValue([]),
      integrationWebhooks: vi.fn(async () => hooks),
      createIntegrationWebhook: vi.fn(async () => {
        hooks = [hook];
        return { ...hook, secret: "whsec_once-only-secret-abcd" };
      }),
    };
    renderSection(api);
    fireEvent.click(
      await screen.findByRole("button", { name: "Create webhook" }),
    );
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Slots" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByTestId("webhook-secret")).toHaveTextContent(
      "whsec_once-only-secret-abcd",
    );
    expect(
      screen.getAllByText(`https://coma.example.com/api/v1/hooks/${hook.id}`)
        .length,
    ).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "I saved the secret" }));
    await waitFor(() =>
      expect(screen.queryByTestId("webhook-secret")).toBeNull(),
    );
    expect(screen.queryByText("whsec_once-only-secret-abcd")).toBeNull();
    expect(await screen.findByText("whsec_••••abcd")).toBeVisible();
  });

  it("hides management for builders without integrations.manage", async () => {
    const api = {
      apiURL: "",
      mcpConnections: vi.fn().mockResolvedValue([connection]),
      integrationWebhooks: vi.fn().mockResolvedValue([hook]),
    };
    renderSection(api, false);
    const card = await screen.findByTestId("mcp-connection");
    expect(
      within(card).queryByRole("button", { name: "Test connection" }),
    ).toBeNull();
    expect(screen.queryByText("Incoming webhooks")).toBeNull();
    expect(api.integrationWebhooks).not.toHaveBeenCalled();
  });
});
