import type { AgentRuntimeMcpServer } from "@comamessenger/core";
import { lookup } from "node:dns";
import type { LookupAddress, LookupOptions } from "node:dns";
import type { LookupFunction } from "node:net";
import { Agent as UndiciAgent } from "undici";

import type { ProviderTool } from "./providers.js";

type Fetcher = typeof fetch;

type JSONRPCResponse = {
  jsonrpc?: string;
  id?: string | number | null;
  result?: unknown;
  error?: { code?: number; message?: string };
};

type MCPTool = {
  name?: unknown;
  description?: unknown;
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: unknown };
};

export type ResolvedMCPTool = {
  definition: ProviderTool;
  serverID: string;
  toolName: string;
  mode: "read" | "write";
  call(
    arguments_: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown>;
};

export class MCPError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "MCPError";
  }
}

export async function resolveMCPTools(
  configurations: AgentRuntimeMcpServer[],
  signal: AbortSignal,
  fetcher: Fetcher = fetch,
): Promise<Map<string, ResolvedMCPTool>> {
  const resolved = new Map<string, ResolvedMCPTool>();
  for (const configuration of configurations) {
    const client = new MCPClient(configuration, fetcher);
    const tools = await client.listTools(signal);
    const allowlist = new Set(configuration.allowed_tools);
    for (const tool of tools) {
      if (!isCompatibleTool(tool) || !allowlist.has(tool.name)) continue;
      const readOnly = tool.annotations?.readOnlyHint === true;
      // Writes that need confirmation stay visible: Core turns the call into
      // a pending approval and executes it itself after a person agrees.
      const exposedName = namespacedToolName(configuration.name, tool.name);
      if (resolved.has(exposedName))
        throw new MCPError("mcp_tool_name_collision");
      resolved.set(exposedName, {
        definition: {
          name: exposedName,
          description: `[MCP:${configuration.name}] ${typeof tool.description === "string" ? tool.description : tool.name}${
            !readOnly && configuration.require_write_confirmation
              ? " (Changes data: a person must approve the call before it runs.)"
              : ""
          }`,
          inputSchema: isObject(tool.inputSchema)
            ? tool.inputSchema
            : { type: "object", additionalProperties: true },
        },
        serverID: configuration.id,
        toolName: tool.name,
        mode: readOnly ? "read" : "write",
        call: (arguments_, callSignal) =>
          client.callTool(tool.name, arguments_, callSignal),
      });
    }
  }
  return resolved;
}

export class MCPClient {
  private sessionID: string | null = null;
  private initialized = false;
  private requestID = 0;
  private readonly dispatcher: UndiciAgent | null;

  constructor(
    private readonly configuration: AgentRuntimeMcpServer,
    private readonly fetcher: Fetcher = fetch,
  ) {
    this.dispatcher =
      fetcher === fetch
        ? secureMCPDispatcher(configuration.allow_private_network === true)
        : null;
  }

  async listTools(signal: AbortSignal): Promise<MCPTool[]> {
    await this.initialize(signal);
    const result = objectValue(await this.request("tools/list", {}, signal));
    const tools = result.tools;
    return Array.isArray(tools) ? tools.filter(isObject) : [];
  }

  async callTool(
    name: string,
    arguments_: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (!this.configuration.allowed_tools.includes(name)) {
      throw new MCPError("mcp_tool_not_allowed");
    }
    await this.initialize(signal);
    return this.request("tools/call", { name, arguments: arguments_ }, signal);
  }

  private async initialize(signal: AbortSignal): Promise<void> {
    if (this.initialized) return;
    await this.request(
      "initialize",
      {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "comamessenger-agent-runtime", version: "0.1.0" },
      },
      signal,
    );
    await this.notify("notifications/initialized", signal);
    this.initialized = true;
  }

  private async request(
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const id = ++this.requestID;
    const response = await this.send(
      { jsonrpc: "2.0", id, method, params },
      signal,
    );
    if (!response || response.id !== id)
      throw new MCPError("mcp_invalid_response");
    if (response.error) throw new MCPError("mcp_rpc_error");
    return response.result;
  }

  private async notify(method: string, signal: AbortSignal): Promise<void> {
    await this.send({ jsonrpc: "2.0", method }, signal, true);
  }

  private async send(
    payload: Record<string, unknown>,
    signal: AbortSignal,
    notification = false,
  ): Promise<JSONRPCResponse | null> {
    assertSafeMCPEndpoint(
      this.configuration.endpoint_url,
      this.configuration.allow_private_network === true,
    );
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.configuration.timeout_ms);
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    try {
      const response = await this.fetcher(this.configuration.endpoint_url, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
        headers: {
          ...this.configuration.headers,
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2025-03-26",
          ...(this.sessionID ? { "Mcp-Session-Id": this.sessionID } : {}),
        },
        body: JSON.stringify(payload),
      } as RequestInit);
      const sessionID = response.headers.get("Mcp-Session-Id");
      if (sessionID) this.sessionID = sessionID;
      if (
        notification &&
        (response.status === 202 || response.status === 204)
      ) {
        return null;
      }
      if (!response.ok) throw new MCPError("mcp_http_error");
      const declaredLength = Number(
        response.headers.get("Content-Length") ?? "0",
      );
      if (declaredLength > this.configuration.max_output_bytes) {
        throw new MCPError("mcp_output_too_large");
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > this.configuration.max_output_bytes) {
        throw new MCPError("mcp_output_too_large");
      }
      if (!bytes.byteLength && notification) return null;
      const body = new TextDecoder().decode(bytes);
      const decoded = response.headers
        .get("Content-Type")
        ?.includes("text/event-stream")
        ? parseEventStream(body)
        : parseJSON(body);
      return responseValue(decoded);
    } catch (cause) {
      if (cause instanceof MCPError) throw cause;
      if (timedOut) throw new MCPError("mcp_timeout");
      if (signal.aborted) throw new MCPError("mcp_aborted");
      throw new MCPError("mcp_transport_error");
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
    }
  }
}

/**
 * Mirrors Core's netguard policy. With allowPrivate (a connection that an
 * administrator marked as a trusted internal system) private, loopback and
 * CGNAT addresses and plain HTTP are allowed; link-local, cloud metadata,
 * multicast and unspecified addresses never are.
 */
export function assertSafeMCPEndpoint(
  endpoint: string,
  allowPrivate = false,
): void {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new MCPError("mcp_endpoint_forbidden");
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  const internalName =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".lan") ||
    host.endsWith(".home.arpa") ||
    !host.includes(".");
  if (
    !(
      parsed.protocol === "https:" ||
      (allowPrivate && parsed.protocol === "http:")
    ) ||
    parsed.username ||
    parsed.password ||
    METADATA_HOSTS.has(host) ||
    (!allowPrivate && internalName) ||
    addressClass(host) === "forbidden" ||
    (!allowPrivate && addressClass(host) === "private")
  ) {
    throw new MCPError("mcp_endpoint_forbidden");
  }
}

const METADATA_HOSTS = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "instance-data.ec2.internal",
]);

function secureMCPDispatcher(allowPrivate: boolean): UndiciAgent {
  return new UndiciAgent({
    connect: { lookup: safeMCPLookup(allowPrivate) },
  });
}

function safeMCPLookup(allowPrivate: boolean): LookupFunction {
  return (hostname: string, options: LookupOptions, callback) => {
    lookup(
      hostname,
      { ...options, all: true, verbatim: true },
      (error, addresses) => {
        if (error) {
          callback(error, "", 0);
          return;
        }
        try {
          const allowed = allowedMCPAddresses(addresses, allowPrivate);
          if (options.all) callback(null, allowed);
          else callback(null, allowed[0]!.address, allowed[0]!.family);
        } catch {
          const denied = new Error(
            "MCP endpoint resolved to a forbidden address",
          );
          Object.assign(denied, { code: "EACCES" });
          callback(denied, "", 0);
        }
      },
    );
  };
}

export function publicMCPAddresses(
  addresses: readonly LookupAddress[],
): LookupAddress[] {
  return allowedMCPAddresses(addresses, false);
}

export function allowedMCPAddresses(
  addresses: readonly LookupAddress[],
  allowPrivate: boolean,
): LookupAddress[] {
  const allowed = addresses.filter(({ address }) => {
    const kind = addressClass(address);
    return kind === "public" || (allowPrivate && kind === "private");
  });
  if (allowed.length === 0) throw new MCPError("mcp_endpoint_forbidden");
  return allowed;
}

/**
 * Classifies a literal address: "forbidden" is never reachable, "private"
 * only for trusted internal connections, "public" always; host names that
 * are not literal addresses are "public" here and checked after DNS.
 */
export function addressClass(
  hostname: string,
): "public" | "private" | "forbidden" {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return addressClass(mapped[1]!);
  if (host.includes(":")) {
    if (host === "::" || /^fe[89ab][0-9a-f]:/.test(host) || /^ff/.test(host))
      return "forbidden";
    if (host === "fd00:ec2::254") return "forbidden";
    if (host === "::1" || /^f[cd][0-9a-f]{2}:/.test(host)) return "private";
    return "public";
  }
  const octets = host.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
  ) {
    return "public";
  }
  const [a, b] = octets as [number, number, number, number];
  if (
    a === 0 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    host === "100.100.100.200"
  )
    return "forbidden";
  if (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19))
  )
    return "private";
  return "public";
}

function responseValue(value: unknown): JSONRPCResponse {
  if (!isObject(value)) throw new MCPError("mcp_invalid_response");
  return value as JSONRPCResponse;
}

function parseJSON(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new MCPError("mcp_invalid_response");
  }
}

function parseEventStream(body: string): unknown {
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data) return parseJSON(data);
  }
  throw new MCPError("mcp_invalid_response");
}

function isCompatibleTool(tool: MCPTool): tool is MCPTool & { name: string } {
  return (
    typeof tool.name === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(tool.name)
  );
}

function namespacedToolName(server: string, tool: string): string {
  const plain = `mcp__${server}__${tool}`;
  if (plain.length <= 64) return plain;
  return `mcp__${server.slice(0, 18)}__${tool.slice(0, 25)}__${fnv1a(plain)}`;
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function objectValue(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
