import { APIError } from "./api";
import { hasPermission } from "./settings";
import type {
  AgentLlmConnection,
  CreateAgentLlmConnectionRequest,
  CreateMcpConnectionRequest,
  McpConnection,
  UpdateAgentLlmConnectionRequest,
  UpdateMcpConnectionRequest,
  User,
} from "./types";

/**
 * Model connections and workspace integrations (MCP, incoming webhooks) of
 * the agent platform, shared by the web and the phone: who may see and
 * change them, drafts, request bodies, address checks and error texts.
 * Secrets typed into a draft are only ever copied into a request body; the
 * server returns hints (`key_hint`, `secret_hint`), never the secret.
 */

/* ---------- Access ---------- */

export type ConnectionsAccess = {
  /** «Модели»: integrations.manage or agents.manage may list them. */
  viewModels: boolean;
  /** «Интеграции»: integrations.manage or agent builders may list MCP. */
  viewIntegrations: boolean;
  /** Create, change, test and delete anything here; see webhooks at all. */
  manage: boolean;
};

export function connectionsAccess(user: User): ConnectionsAccess {
  const manage = hasPermission(user, "integrations.manage");
  return {
    manage,
    viewModels: manage || hasPermission(user, "agents.manage"),
    viewIntegrations: manage || hasPermission(user, "agents.build"),
  };
}

/* ---------- Addresses ---------- */

type ParsedURL = {
  scheme: string;
  userinfo: boolean;
  host: string;
  port: string;
  fragment: boolean;
};

/** Enough of RFC 3986 for the server's own checks; null when malformed. */
export function parseEndpoint(raw: string): ParsedURL | null {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^#]*)(#.*)?$/.exec(
    raw.trim(),
  );
  if (!match) return null;
  const authority = match[2]!;
  const at = authority.lastIndexOf("@");
  const hostPort = at >= 0 ? authority.slice(at + 1) : authority;
  const hostMatch = /^(\[[^\]]+\]|[^:]*)(?::(\d*))?$/.exec(hostPort);
  if (!hostMatch) return null;
  const host = hostMatch[1]!.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) return null;
  return {
    scheme: match[1]!.toLowerCase(),
    userinfo: at >= 0,
    host: host.replace(/\.$/, ""),
    port: hostMatch[2] ?? "",
    fragment: match[4] !== undefined,
  };
}

export type EndpointProblem =
  | "required"
  | "invalid"
  | "scheme"
  | "credentials"
  | "metadata"
  | "internal";

const metadataHosts = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "instance-data.ec2.internal",
  "metadata.azure.com",
  "169.254.169.254",
  "fd00:ec2::254",
]);

/** A host the server only reaches when the operator lists it. */
export function isInternalHost(host: string): boolean {
  if (host.includes(":")) return isInternalIPv6(host);
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  return (
    !host.includes(".") ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".lan") ||
    host.endsWith(".home.arpa")
  );
}

function isInternalIPv6(host: string): boolean {
  return (
    host === "::1" ||
    host === "::" ||
    /^f[cd][0-9a-f]{2}:/.test(host) ||
    /^fe[89ab][0-9a-f]:/.test(host)
  );
}

/**
 * Address of an OpenAI-compatible provider, as the server accepts it:
 * http(s), a host, no credentials and no fragment.
 */
export function llmEndpointProblem(raw: string): EndpointProblem | null {
  if (!raw.trim()) return "required";
  if (raw.trim().length > 2048) return "invalid";
  const parsed = parseEndpoint(raw);
  if (!parsed) return "invalid";
  if (parsed.scheme !== "http" && parsed.scheme !== "https") return "scheme";
  if (parsed.userinfo || parsed.fragment) return "credentials";
  return null;
}

/**
 * Address of an MCP server against the server's outbound guard. «internal»
 * is a hint, not a refusal: internal systems and plain http work only with
 * «Система во внутренней сети» and the operator's allow-list.
 */
export function mcpEndpointProblem(
  raw: string,
  allowPrivateNetwork: boolean,
): EndpointProblem | null {
  const base = llmEndpointProblem(raw);
  if (base) return base;
  const parsed = parseEndpoint(raw)!;
  if (metadataHosts.has(parsed.host)) return "metadata";
  if (
    !allowPrivateNetwork &&
    (parsed.scheme === "http" || isInternalHost(parsed.host))
  )
    return "internal";
  return null;
}

/** Scheme, host and port: a new origin drops the stored MCP headers. */
export function endpointOrigin(raw: string): string {
  const parsed = parseEndpoint(raw);
  if (!parsed) return raw.trim();
  const port =
    parsed.port ||
    (parsed.scheme === "https" ? "443" : parsed.scheme === "http" ? "80" : "");
  return `${parsed.scheme}://${parsed.host}:${port}`;
}

/* ---------- Secrets ---------- */

/**
 * A secret reduced to its recognisable ends — «sk-…4f2a» — for a
 * confirmation after pasting. Short secrets show nothing at all.
 */
export function maskSecret(secret: string): string {
  const value = secret.trim();
  if (value.length < 12) return "••••";
  const prefix = /^[A-Za-z]{1,8}[-_]/.exec(value)?.[0] ?? "";
  return `${prefix}…${value.slice(-4)}`;
}

/* ---------- Model connections ---------- */

export const llmProviders = [
  "openai",
  "anthropic",
  "openai-compatible",
] as const;
export type LlmProvider = (typeof llmProviders)[number];

export type LlmConnectionDraft = {
  name: string;
  provider: LlmProvider;
  endpoint_url: string;
  default_model: string;
  api_key: string;
};

export const emptyLlmConnectionDraft: LlmConnectionDraft = {
  name: "",
  provider: "openai",
  endpoint_url: "",
  default_model: "",
  api_key: "",
};

export function providerNeedsEndpoint(provider: string): boolean {
  return provider === "openai-compatible";
}

/** Anthropic has no embeddings API, so its connections cannot embed. */
export function providerSupportsEmbeddings(provider: string): boolean {
  return provider === "openai" || provider === "openai-compatible";
}

/** Switching away from a compatible provider drops its address. */
export function withProvider<
  T extends { provider: string; endpoint_url: string },
>(draft: T, provider: LlmProvider): T {
  return {
    ...draft,
    provider,
    endpoint_url: providerNeedsEndpoint(provider) ? draft.endpoint_url : "",
  };
}

/** The web's «Сохранить» rule: a name, a key and, if needed, an address. */
export function llmConnectionDraftReady(draft: LlmConnectionDraft): boolean {
  return Boolean(
    draft.name.trim() &&
      draft.api_key.trim() &&
      (!providerNeedsEndpoint(draft.provider) || draft.endpoint_url.trim()),
  );
}

export function createLlmConnectionRequest(
  draft: LlmConnectionDraft,
): CreateAgentLlmConnectionRequest {
  return { ...draft, enabled: true };
}

/** What the edit form of a saved model connection holds; the key is new or empty. */
export type LlmConnectionEdit = {
  name: string;
  provider: LlmProvider;
  endpoint_url: string;
  default_model: string;
  /** Empty keeps the stored key. */
  api_key: string;
  embedding_model: string;
  embedding_data_sharing_approved: boolean;
};

export function llmConnectionEdit(
  connection: AgentLlmConnection,
): LlmConnectionEdit {
  return {
    name: connection.name,
    provider: connection.provider,
    endpoint_url: connection.endpoint_url,
    default_model: connection.default_model,
    api_key: "",
    embedding_model: connection.embedding_model ?? "",
    embedding_data_sharing_approved:
      connection.embedding_data_sharing_approved ?? false,
  };
}

/** Only the changed fields; null when nothing changed. */
export function updateLlmConnectionRequest(
  connection: AgentLlmConnection,
  edit: LlmConnectionEdit,
): UpdateAgentLlmConnectionRequest | null {
  const request: UpdateAgentLlmConnectionRequest = {};
  const name = edit.name.trim();
  const endpoint = providerNeedsEndpoint(edit.provider)
    ? edit.endpoint_url.trim()
    : "";
  const model = edit.default_model.trim();
  const embedding = providerSupportsEmbeddings(edit.provider)
    ? edit.embedding_model.trim()
    : "";
  if (name !== connection.name) request.name = name;
  if (edit.provider !== connection.provider) request.provider = edit.provider;
  if (endpoint !== connection.endpoint_url) request.endpoint_url = endpoint;
  if (model !== connection.default_model) request.default_model = model;
  if (edit.api_key.trim()) request.api_key = edit.api_key.trim();
  if (embedding !== (connection.embedding_model ?? ""))
    request.embedding_model = embedding;
  const approved = Boolean(embedding) && edit.embedding_data_sharing_approved;
  if (approved !== (connection.embedding_data_sharing_approved ?? false))
    request.embedding_data_sharing_approved = approved;
  return Object.keys(request).length ? request : null;
}

export function llmConnectionEditReady(edit: LlmConnectionEdit): boolean {
  return Boolean(
    edit.name.trim() &&
      (!providerNeedsEndpoint(edit.provider) ||
        llmEndpointProblem(edit.endpoint_url) === null),
  );
}

/* ---------- MCP connections ---------- */

/** The name agents see as mcp__<name>__<tool>. */
export const mcpNamePattern = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export type McpConnectionDraft = {
  name: string;
  description: string;
  endpoint_url: string;
  header_name: string;
  header_value: string;
  allow_private_network: boolean;
  agent_use_allowed: boolean;
  writes_require_confirmation: boolean;
};

export const emptyMcpConnectionDraft: McpConnectionDraft = {
  name: "",
  description: "",
  endpoint_url: "",
  header_name: "Authorization",
  header_value: "",
  allow_private_network: false,
  agent_use_allowed: false,
  writes_require_confirmation: true,
};

export function mcpConnectionDraftReady(draft: McpConnectionDraft): boolean {
  return (
    mcpNamePattern.test(draft.name.trim()) && Boolean(draft.endpoint_url.trim())
  );
}

/** One authorization header, or nothing when either half is empty. */
export function mcpHeaders(
  name: string,
  value: string,
): Record<string, string> | undefined {
  return name.trim() && value.trim()
    ? { [name.trim()]: value.trim() }
    : undefined;
}

export function createMcpConnectionRequest(
  draft: McpConnectionDraft,
): CreateMcpConnectionRequest {
  const headers = mcpHeaders(draft.header_name, draft.header_value);
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    endpoint_url: draft.endpoint_url.trim(),
    enabled: true,
    allow_private_network: draft.allow_private_network,
    agent_use_allowed: draft.agent_use_allowed,
    writes_require_confirmation: draft.writes_require_confirmation,
    ...(headers ? { headers } : {}),
  };
}

/** `assignable_tools` null means every tool of the catalog. */
export function isMcpToolAssignable(
  connection: Pick<McpConnection, "assignable_tools">,
  tool: string,
): boolean {
  return (
    connection.assignable_tools == null ||
    connection.assignable_tools.includes(tool)
  );
}

/** The assignable list after one tool's switch changes. */
export function toggledAssignableTools(
  connection: Pick<McpConnection, "assignable_tools" | "tools">,
  tool: string,
  assignable: boolean,
): string[] {
  const current =
    connection.assignable_tools ?? connection.tools.map((item) => item.name);
  return assignable
    ? [...current, tool]
    : current.filter((name) => name !== tool);
}

export type McpConnectionEdit = {
  description: string;
  endpoint_url: string;
  allow_private_network: boolean;
  /** True replaces the stored headers with the two fields below. */
  replace_headers: boolean;
  header_name: string;
  header_value: string;
  timeout_ms: number;
  max_output_bytes: number;
};

export const mcpTimeoutRange = { min: 100, max: 120000 } as const;
export const mcpOutputRange = { min: 1024, max: 4194304 } as const;

export function mcpConnectionEdit(
  connection: McpConnection,
): McpConnectionEdit {
  return {
    description: connection.description,
    endpoint_url: connection.endpoint_url,
    allow_private_network: connection.allow_private_network,
    replace_headers: false,
    header_name: "Authorization",
    header_value: "",
    timeout_ms: connection.timeout_ms,
    max_output_bytes: connection.max_output_bytes,
  };
}

export function updateMcpConnectionRequest(
  connection: McpConnection,
  edit: McpConnectionEdit,
): UpdateMcpConnectionRequest | null {
  const request: UpdateMcpConnectionRequest = {};
  if (edit.description.trim() !== connection.description)
    request.description = edit.description.trim();
  if (edit.endpoint_url.trim() !== connection.endpoint_url)
    request.endpoint_url = edit.endpoint_url.trim();
  if (edit.allow_private_network !== connection.allow_private_network)
    request.allow_private_network = edit.allow_private_network;
  if (edit.replace_headers)
    request.headers = mcpHeaders(edit.header_name, edit.header_value) ?? {};
  if (edit.timeout_ms !== connection.timeout_ms)
    request.timeout_ms = edit.timeout_ms;
  if (edit.max_output_bytes !== connection.max_output_bytes)
    request.max_output_bytes = edit.max_output_bytes;
  return Object.keys(request).length ? request : null;
}

/** A new origin without new headers erases the stored key on the server. */
export function mcpEditDropsSecret(
  connection: McpConnection,
  edit: McpConnectionEdit,
): boolean {
  return (
    connection.headers_configured &&
    !edit.replace_headers &&
    endpointOrigin(edit.endpoint_url) !==
      endpointOrigin(connection.endpoint_url)
  );
}

export function mcpConnectionEditReady(edit: McpConnectionEdit): boolean {
  return (
    llmEndpointProblem(edit.endpoint_url) === null &&
    edit.timeout_ms >= mcpTimeoutRange.min &&
    edit.timeout_ms <= mcpTimeoutRange.max &&
    edit.max_output_bytes >= mcpOutputRange.min &&
    edit.max_output_bytes <= mcpOutputRange.max &&
    (!edit.replace_headers ||
      !edit.header_value.trim() ||
      Boolean(edit.header_name.trim()))
  );
}

/* ---------- Incoming webhooks ---------- */

/**
 * The address an external system posts to. `base` is the API address
 * (or the page origin on the web); only its origin is used.
 */
export function webhookURL(base: string, id: string): string {
  const origin = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*/.exec(base)?.[0] ?? base;
  return `${origin}/api/v1/hooks/${encodeURIComponent(id)}`;
}

export const webhookRateRange = { min: 1, max: 6000 } as const;

export function validWebhookRate(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= webhookRateRange.min &&
    value <= webhookRateRange.max
  );
}

/* ---------- Errors ---------- */

/** Translation key of a stored health error code (`last_error_code`). */
export function connectionErrorKey(code: string): string {
  switch (code) {
    case "unauthorized":
    case "mcp_unauthorized":
      return "connectionErrorUnauthorized";
    case "forbidden":
      return "connectionErrorForbidden";
    case "rate_limited":
      return "connectionErrorRateLimited";
    case "network_error":
    case "mcp_transport_error":
      return "connectionErrorNetwork";
    case "mcp_timeout":
      return "connectionErrorTimeout";
    case "credentials_required":
      return "connectionErrorCredentialsRequired";
    case "mcp_endpoint_forbidden":
      return "connectionErrorEndpointForbidden";
    case "mcp_redirect_refused":
      return "connectionErrorRedirect";
    case "mcp_output_too_large":
      return "connectionErrorTooLarge";
    case "provider_error":
    case "mcp_http_error":
    case "mcp_invalid_response":
    case "mcp_rpc_error":
      return "connectionErrorProvider";
    default:
      return "connectionErrorUnknown";
  }
}

/**
 * Translation key of a failed request on these screens, where a generic
 * text would not tell the administrator what to do; null falls back to the
 * shared `apiErrorKey`.
 */
export function connectionRequestErrorKey(
  cause: unknown,
  kind: "model" | "mcp" | "webhook",
): string | null {
  if (!(cause instanceof APIError)) return null;
  if (cause.code === "integration_usage_changed")
    return "connectionUsageChanged";
  if (cause.code === "integration_in_use" || cause.status === 409)
    return kind === "model"
      ? "modelConnectionInUse"
      : kind === "mcp"
        ? "mcpConnectionInUse"
        : "webhookInUse";
  if (cause.status === 422 && kind === "mcp")
    return cause.message.includes("INTEGRATIONS_ALLOWED_PRIVATE_TARGETS")
      ? "mcpPrivateTargetNotAllowed"
      : "mcpEndpointRejected";
  if (cause.status === 422 && kind === "model") return "modelConnectionInvalid";
  return null;
}
