import type { AgentRuntimeMcpServer } from "@comamessenger/core";
import { lookup } from "node:dns";
import { isIPv4, isIPv6 } from "node:net";
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
            !readOnly &&
            (configuration.tool_confirmation?.[tool.name] ??
              (configuration.require_write_confirmation ? "confirm" : "auto")) ===
              "confirm"
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
        ? secureMCPDispatcher(privatePolicy(configuration))
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
      privatePolicy(this.configuration),
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
 * Mirrors Core's netguard policy. Internal destinations are reachable only
 * through a connection that Core released for a listed internal system
 * (`allow_private_network` with `allowed_private_cidrs`); plain HTTP only
 * then. Link-local, cloud metadata, multicast and unspecified addresses never
 * are, including when wrapped in IPv4-mapped, IPv4-compatible, NAT64 or 6to4
 * IPv6 forms.
 */
export function assertSafeMCPEndpoint(
  endpoint: string,
  policy: PrivatePolicy = NO_PRIVATE,
): void {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new MCPError("mcp_endpoint_forbidden");
  }
  const host = parsed.hostname
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^\[|\]$/g, "");
  const internalName =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".lan") ||
    host.endsWith(".home.arpa") ||
    !host.includes(".");
  const literal = parseAddress(host);
  if (
    !(
      parsed.protocol === "https:" ||
      (policy.allowPrivate && parsed.protocol === "http:")
    ) ||
    parsed.username ||
    parsed.password ||
    METADATA_HOSTS.has(host) ||
    (!literal && internalName && !policy.allowPrivate) ||
    (literal && !addressAllowed(literal, policy))
  ) {
    throw new MCPError("mcp_endpoint_forbidden");
  }
}

export type PrivatePolicy = { allowPrivate: boolean; cidrs: string[] };

const NO_PRIVATE: PrivatePolicy = { allowPrivate: false, cidrs: [] };

export function privatePolicy(
  configuration: Pick<
    AgentRuntimeMcpServer,
    "allow_private_network" | "allowed_private_cidrs"
  >,
): PrivatePolicy {
  const cidrs = configuration.allowed_private_cidrs ?? [];
  return {
    allowPrivate:
      configuration.allow_private_network === true && cidrs.length > 0,
    cidrs,
  };
}

const METADATA_HOSTS = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "metadata.azure.com",
  "instance-data",
  "instance-data.ec2.internal",
]);

function secureMCPDispatcher(policy: PrivatePolicy): UndiciAgent {
  return new UndiciAgent({
    connect: { lookup: safeMCPLookup(policy) },
  });
}

function safeMCPLookup(policy: PrivatePolicy): LookupFunction {
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
          const allowed = allowedMCPAddresses(addresses, policy);
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
  return allowedMCPAddresses(addresses, NO_PRIVATE);
}

export function allowedMCPAddresses(
  addresses: readonly LookupAddress[],
  policy: PrivatePolicy,
): LookupAddress[] {
  const allowed = addresses.filter(({ address }) => {
    const parsed = parseAddress(address);
    return parsed !== null && addressAllowed(parsed, policy);
  });
  if (allowed.length === 0) throw new MCPError("mcp_endpoint_forbidden");
  return allowed;
}

/** An address as bytes: 4 for IPv4, 16 for IPv6. */
type Address = number[];

/** Parses a literal IPv4 or IPv6 address (with optional zone); null otherwise. */
export function parseAddress(value: string): Address | null {
  const host = value.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (isIPv4(host)) return host.split(".").map(Number);
  if (!isIPv6(host)) return null;
  let text = host.toLowerCase();
  let tail: number[] = [];
  const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    tail = dotted[2]!.split(".").map(Number);
    text = dotted[1]!.endsWith("::") ? dotted[1]! : dotted[1]!.slice(0, -1);
  }
  const [head, rest] = text.includes("::") ? text.split("::") : [text, null];
  const groups = (part: string | undefined) =>
    part
      ? part
          .split(":")
          .filter(Boolean)
          .map((group) => parseInt(group, 16))
      : [];
  const left = groups(head);
  const right = rest === null ? [] : groups(rest);
  const needed = 8 - tail.length / 2;
  const middle =
    rest === null ? [] : new Array(needed - left.length - right.length).fill(0);
  const words = [...left, ...middle, ...right];
  if (words.length !== needed) return null;
  const bytes = words.flatMap((word) => [word >> 8, word & 0xff]);
  return [...bytes, ...tail];
}

/** The IPv4 address embedded in mapped, compatible, NAT64 or 6to4 forms. */
export function embeddedAddress(address: Address): Address {
  if (address.length === 4) return address;
  const zero = (from: number, to: number) =>
    address.slice(from, to).every((byte) => byte === 0);
  if (zero(0, 10) && address[10] === 0xff && address[11] === 0xff)
    return address.slice(12);
  if (
    address[0] === 0x00 &&
    address[1] === 0x64 &&
    address[2] === 0xff &&
    address[3] === 0x9b &&
    zero(4, 12)
  )
    return address.slice(12);
  if (address[0] === 0x20 && address[1] === 0x02) return address.slice(2, 6);
  if (
    zero(0, 12) &&
    !(zero(12, 15) && (address[15] === 0 || address[15] === 1))
  )
    return address.slice(12);
  return address;
}

function inPrefix(address: Address, prefix: Address, bits: number): boolean {
  if (address.length !== prefix.length) return false;
  for (let index = 0; index < bits; index++) {
    const byte = Math.floor(index / 8);
    const mask = 0x80 >> index % 8;
    if ((address[byte]! & mask) !== (prefix[byte]! & mask)) return false;
  }
  return true;
}

function cidr(text: string): [Address, number] | null {
  const [base, bits] = text.split("/");
  const address = base ? parseAddress(base) : null;
  if (!address) return null;
  const length = bits === undefined ? address.length * 8 : Number(bits);
  return Number.isInteger(length) && length >= 0 && length <= address.length * 8
    ? [address, length]
    : null;
}

const FORBIDDEN = [
  "0.0.0.0/8",
  "224.0.0.0/3",
  "169.254.0.0/16",
  "100.100.100.200/32",
  "168.63.129.16/32",
  "192.0.0.192/32",
  "::/128",
  "ff00::/8",
  "fe80::/10",
  "fd00:ec2::254/128",
].map((value) => cidr(value)!);

const INTERNAL = [
  "10.0.0.0/8",
  "127.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "100.64.0.0/10",
  "192.0.0.0/24",
  "198.18.0.0/15",
  "192.0.2.0/24",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "::1/128",
  "fc00::/7",
  "2001:db8::/32",
].map((value) => cidr(value)!);

/**
 * Classifies a literal address: "forbidden" is never reachable, "private"
 * only through a listed internal system, "public" always. Host names that are
 * not literal addresses are "public" here and checked after DNS.
 */
export function addressClass(
  hostname: string,
): "public" | "private" | "forbidden" {
  const parsed = parseAddress(hostname);
  if (!parsed) return "public";
  return classify(parsed);
}

function classify(address: Address): "public" | "private" | "forbidden" {
  for (const candidate of [address, embeddedAddress(address)]) {
    if (FORBIDDEN.some(([prefix, bits]) => inPrefix(candidate, prefix, bits)))
      return "forbidden";
  }
  const embedded = embeddedAddress(address);
  if (
    [address, embedded].some((candidate) =>
      INTERNAL.some(([prefix, bits]) => inPrefix(candidate, prefix, bits)),
    )
  )
    return "private";
  return "public";
}

function addressAllowed(address: Address, policy: PrivatePolicy): boolean {
  const kind = classify(address);
  if (kind === "forbidden") return false;
  if (kind === "public") return true;
  if (!policy.allowPrivate) return false;
  const embedded = embeddedAddress(address);
  return policy.cidrs.some((value) => {
    const parsed = cidr(value);
    return (
      parsed !== null &&
      (inPrefix(address, parsed[0], parsed[1]) ||
        inPrefix(embedded, parsed[0], parsed[1]))
    );
  });
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
