import { describe, expect, it, vi } from "vitest";

import type { AgentRuntimeMcpServer } from "@comamessenger/core";

import {
  MCPClient,
  MCPError,
  publicMCPAddresses,
  resolveMCPTools,
} from "./mcp.js";

const configuration: AgentRuntimeMcpServer = {
  id: "01900000-0000-7000-8000-000000000001",
  name: "knowledge",
  endpoint_url: "https://mcp.example.test/rpc",
  allowed_tools: ["read", "write", "hidden"],
  headers: { Authorization: "Bearer top-secret" },
  timeout_ms: 100,
  max_output_bytes: 4096,
  require_write_confirmation: true,
};

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function protocolFetcher(tools: unknown[]): typeof fetch {
  return vi.fn(async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as {
      id?: number;
      method: string;
    };
    if (request.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    if (request.method === "initialize") {
      return jsonResponse({ jsonrpc: "2.0", id: request.id, result: {} });
    }
    return jsonResponse({
      jsonrpc: "2.0",
      id: request.id,
      result: { tools },
    });
  }) as typeof fetch;
}

describe("MCP security boundaries", () => {
  it.each([
    "http://mcp.example.test/rpc",
    "https://127.0.0.1/rpc",
    "https://10.0.0.5/rpc",
    "https://metadata.internal/rpc",
  ])("rejects unsafe endpoint %s before transport", async (endpoint_url) => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    const client = new MCPClient({ ...configuration, endpoint_url }, fetcher);
    await expect(
      client.listTools(new AbortController().signal),
    ).rejects.toMatchObject({ code: "mcp_endpoint_forbidden" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("enforces allowlist and suppresses unconfirmed write tools", async () => {
    const fetcher = protocolFetcher([
      {
        name: "read",
        description: "Read",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: true },
      },
      {
        name: "write",
        description: "Write",
        inputSchema: { type: "object" },
      },
      {
        name: "not_allowlisted",
        description: "Hidden",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: true },
      },
    ]);
    const tools = await resolveMCPTools(
      [configuration],
      new AbortController().signal,
      fetcher,
    );
    expect([...tools.keys()]).toEqual(["mcp__knowledge__read"]);
    const firstRequest = vi.mocked(fetcher).mock.calls[0];
    expect(firstRequest?.[1]?.redirect).toBe("error");
    expect(
      (firstRequest?.[1]?.headers as Record<string, string>).Authorization,
    ).toBe("Bearer top-secret");
  });

  it("pins DNS results to public addresses only", () => {
    expect(
      publicMCPAddresses([
        { address: "10.0.0.5", family: 4 },
        { address: "93.184.216.34", family: 4 },
        { address: "::ffff:127.0.0.1", family: 6 },
      ]),
    ).toEqual([{ address: "93.184.216.34", family: 4 }]);
    expect(() =>
      publicMCPAddresses([
        { address: "127.0.0.1", family: 4 },
        { address: "fe80::1", family: 6 },
      ]),
    ).toThrow("mcp_endpoint_forbidden");
  });

  it("rejects oversized output before parsing", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse(
        { jsonrpc: "2.0", id: 1, result: {} },
        {
          headers: {
            "Content-Type": "application/json",
            "Content-Length": "5000",
          },
        },
      ),
    ) as typeof fetch;
    const client = new MCPClient(configuration, fetcher);
    await expect(
      client.listTools(new AbortController().signal),
    ).rejects.toMatchObject({
      code: "mcp_output_too_large",
    });
  });

  it("times out without leaking endpoint or secret", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("Bearer top-secret")),
          );
        }),
    ) as typeof fetch;
    const client = new MCPClient({ ...configuration, timeout_ms: 5 }, fetcher);
    let caught: unknown;
    try {
      await client.listTools(new AbortController().signal);
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBeInstanceOf(MCPError);
    expect((caught as MCPError).code).toBe("mcp_timeout");
    expect(String(caught)).not.toContain("top-secret");
    expect(String(caught)).not.toContain(configuration.endpoint_url);
  });
});
