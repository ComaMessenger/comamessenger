import { AgentSDKError, type AgentRecipe } from "./index.js";

export type ProvisionedAgent = {
  agent: { id: string; display_name: string; handle: string };
  apiKey: string;
};

export type ProvisionAgentInput = {
  displayName?: string;
  handle?: string;
  chatIDs: string[];
  endpointURL?: string;
  rateLimitPerMinute?: number;
};

export type SimulationKind = "mention" | "command" | "schedule";

export class AgentAdminClient {
  private readonly baseURL: string;

  constructor(
    baseURL: string,
    private readonly accessToken: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.baseURL = baseURL.replace(/\/$/, "");
  }

  async provisionExternalAgent(
    recipe: AgentRecipe,
    input: ProvisionAgentInput,
  ): Promise<ProvisionedAgent> {
    if (input.chatIDs.length === 0) {
      throw new AgentSDKError(
        "chat_required",
        0,
        "At least one chat is required",
      );
    }
    const handle = input.handle ?? safeHandle(recipe.name);
    const scopes = scopesForRecipe(recipe);
    const agent = await this.request<{
      id: string;
      display_name: string;
      handle: string;
    }>("/api/v1/agents", {
      method: "POST",
      body: JSON.stringify({
        display_name: input.displayName ?? recipe.name,
        handle,
        kind: "external",
        recipe: "custom",
        description: recipe.instructions,
        enabled: false,
        allowed_scopes: scopes,
        endpoint_url: input.endpointURL ?? "http://127.0.0.1",
        external_data_sharing_approved: false,
        rate_limit_per_minute: input.rateLimitPerMinute ?? 300,
        provider_rate_limit_per_minute: 300,
        execution_timeout_seconds: 600,
        max_output_tokens: 2048,
        max_tool_iterations: 8,
        max_chain_depth: 3,
        per_chat_concurrency: 1,
        chat_ids: input.chatIDs,
      }),
    });
    try {
      const key = await this.request<{ secret: string }>(
        `/api/v1/agents/${encodeURIComponent(agent.id)}/keys`,
        {
          method: "POST",
          body: JSON.stringify({
            name: "coma-agent-dev",
            scopes,
            rate_limit_per_minute: input.rateLimitPerMinute ?? 300,
          }),
        },
      );
      await this.request(`/api/v1/agents/${encodeURIComponent(agent.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: true }),
      });
      return { agent, apiKey: key.secret };
    } catch (error) {
      await this.request(`/api/v1/agents/${encodeURIComponent(agent.id)}`, {
        method: "DELETE",
      }).catch(() => undefined);
      throw error;
    }
  }

  simulate(input: {
    agentID: string;
    chatID: string;
    kind: SimulationKind;
    text?: string;
    command?: string;
  }): Promise<{ id: string; correlation_id: string; status: string }> {
    return this.request(
      `/api/v1/agents/${encodeURIComponent(input.agentID)}/invoke`,
      {
        method: "POST",
        body: JSON.stringify({
          chat_id: input.chatID,
          client_run_id: crypto.randomUUID(),
          chain_depth: 0,
          timeout_seconds: 600,
          max_attempts: 1,
          input: simulationInput(input),
        }),
      },
    );
  }

  private async request<T = unknown>(
    path: string,
    init: RequestInit,
  ): Promise<T> {
    const response = await this.fetcher(`${this.baseURL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as {
        code?: string;
        message?: string;
      };
      throw new AgentSDKError(
        payload.code ?? "request_failed",
        response.status,
        payload.message ?? `Core returned HTTP ${response.status}`,
      );
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}

export function simulationInput(input: {
  kind: SimulationKind;
  text?: string;
  command?: string;
}): Record<string, unknown> {
  if (input.kind === "command") {
    const raw = (input.command ?? input.text ?? "/test").trim();
    const [command, ...rest] = raw.replace(/^\//, "").split(/\s+/);
    return {
      simulated: true,
      trigger: { type: "command", command, arguments: rest.join(" ") },
    };
  }
  if (input.kind === "schedule") {
    return {
      simulated: true,
      trigger: {
        type: "schedule",
        scheduled_for: new Date().toISOString(),
        since_last_run: null,
      },
    };
  }
  return {
    simulated: true,
    trigger: { type: "mention", text: input.text ?? "@agent test" },
  };
}

export function scopesForRecipe(recipe: AgentRecipe): string[] {
  const scopes = new Set<string>(["runtime:execute"]);
  const byTool: Record<string, string> = {
    get_chat_messages: "messages:read",
    get_thread: "messages:read",
    search_messages: "search:read",
    post_message: "messages:write",
    reply_in_thread: "messages:write",
    add_reaction: "reactions:write",
    get_file_text: "files:read",
    list_members: "members:read",
    remember: "memory:write",
    recall: "memory:read",
  };
  for (const tool of recipe.tools) {
    const scope = byTool[tool];
    if (scope) scopes.add(scope);
  }
  return [...scopes].sort();
}

function safeHandle(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
    .slice(0, 24);
  return `${normalized || "agent"}-${crypto.randomUUID().slice(0, 7)}`;
}
