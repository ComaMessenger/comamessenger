export type AgentRun = {
  id: string;
  agent_id: string;
  chat_id?: string;
  thread_root_id?: string;
  correlation_id: string;
  provider: string;
  model: string;
  input: Record<string, unknown>;
  status: string;
  lease_token: string;
};

export type ToolDefinition = {
  name: string;
  description: string;
  mode: "read" | "write";
  required_scope: string;
  input_schema: Record<string, unknown>;
};

export type AgentRecipe = {
  name: string;
  version: number;
  instructions: string;
  triggers: readonly string[];
  tools: readonly string[];
};

export type RuntimeEvent =
  | { op: "hello"; current_seq: number }
  | { op: "event"; seq: number; type: string; data: Record<string, unknown> }
  | { op: "resync_required"; current_seq: number }
  | { op: "error"; code: string; message: string; fatal: boolean };

export class AgentSDKError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AgentSDKError";
  }
}

export class AgentClient {
  private readonly baseURL: string;

  constructor(
    baseURL: string,
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.baseURL = baseURL.replace(/\/$/, "");
  }

  async claim(input: {
    workerID: string;
    leaseSeconds?: number;
    waitSeconds?: number;
  }): Promise<AgentRun | null> {
    const response = await this.raw("/api/v1/agent-runtime/runs/claim", {
      method: "POST",
      body: JSON.stringify({
        worker_id: input.workerID,
        lease_seconds: input.leaseSeconds ?? 90,
        wait_seconds: input.waitSeconds ?? 25,
      }),
    });
    if (response.status === 204) return null;
    return decode<AgentRun>(response);
  }

  heartbeat(run: AgentRun, leaseSeconds = 90): Promise<AgentRun> {
    return this.request(`/api/v1/agent-runtime/runs/${run.id}/heartbeat`, {
      method: "POST",
      body: JSON.stringify({
        lease_token: run.lease_token,
        lease_seconds: leaseSeconds,
      }),
    });
  }

  complete(
    run: AgentRun,
    resultSummary: Record<string, unknown>,
  ): Promise<AgentRun> {
    return this.request(`/api/v1/agent-runtime/runs/${run.id}/complete`, {
      method: "POST",
      body: JSON.stringify({
        lease_token: run.lease_token,
        input_tokens: 0,
        output_tokens: 0,
        cost: "0",
        currency: "USD",
        price_source: "unknown",
        result_summary: resultSummary,
      }),
    });
  }

  fail(run: AgentRun, errorCode: string): Promise<AgentRun> {
    return this.request(`/api/v1/agent-runtime/runs/${run.id}/fail`, {
      method: "POST",
      body: JSON.stringify({
        lease_token: run.lease_token,
        error_code: errorCode,
      }),
    });
  }

  tools(): Promise<ToolDefinition[]> {
    return this.request("/api/v1/agent-tools");
  }

  invokeTool<T>(
    run: AgentRun,
    name: string,
    arguments_: Record<string, unknown>,
  ): Promise<T> {
    return this.request(`/api/v1/agent-tools/${encodeURIComponent(name)}`, {
      method: "POST",
      body: JSON.stringify({
        run_id: run.id,
        correlation_id: run.correlation_id,
        confirmed: false,
        arguments: arguments_,
      }),
    });
  }

  websocketURL(): string {
    const url = new URL(this.baseURL);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `${url.pathname.replace(/\/$/, "")}/api/v1/ws`;
    return url.toString();
  }

  token(): string {
    return this.apiKey;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    return decode<T>(await this.raw(path, init));
  }

  private raw(path: string, init: RequestInit): Promise<Response> {
    return this.fetcher(`${this.baseURL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
  }
}

export class DeltaCoalescer {
  private pending = "";
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly emit: (value: string) => void,
    private readonly intervalMS = 125,
    private readonly maxBytes = 8192,
  ) {}

  push(value: string): void {
    if (!value) return;
    for (const character of value) {
      const candidate = this.pending + character;
      if (new TextEncoder().encode(candidate).byteLength > this.maxBytes) {
        this.flush();
      }
      this.pending += character;
    }
    this.timer ??= setTimeout(() => this.flush(), this.intervalMS);
  }

  close(): void {
    this.flush();
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.pending) return;
    const value = this.pending;
    this.pending = "";
    this.emit(value);
  }
}

export class RuntimeSocket {
  private socket: WebSocket | null = null;
  private lastAck = 0;

  constructor(
    private readonly client: AgentClient,
    private readonly onEvent: (event: RuntimeEvent) => void,
  ) {}

  connect(lastSeq = 0): void {
    const socket = new WebSocket(this.client.websocketURL());
    this.socket = socket;
    socket.addEventListener("open", () =>
      socket.send(
        JSON.stringify({
          op: "auth",
          request_id: crypto.randomUUID(),
          access_token: this.client.token(),
          last_seq: lastSeq,
        }),
      ),
    );
    socket.addEventListener("message", (message) => {
      const event = JSON.parse(String(message.data)) as RuntimeEvent;
      this.onEvent(event);
      if (event.op === "event") {
        this.lastAck = Math.max(this.lastAck, event.seq);
        socket.send(JSON.stringify({ op: "ack", seq: this.lastAck }));
      }
      if (event.op === "error" && event.fatal) socket.close();
    });
  }

  status(run: AgentRun, state: string): void {
    this.send({
      op: "agent.status",
      run_id: run.id,
      chat_id: run.chat_id,
      thread_root_id: run.thread_root_id ?? null,
      state,
    });
  }

  stream(
    run: AgentRun,
    input: {
      streamID: string;
      index: number;
      delta: string;
      reset?: boolean;
      done?: boolean;
    },
  ): void {
    this.send({
      op: "message.streaming",
      run_id: run.id,
      chat_id: run.chat_id,
      thread_root_id: run.thread_root_id ?? null,
      stream_id: input.streamID,
      index: input.index,
      delta: input.delta,
      reset: input.reset ?? false,
      done: input.done ?? false,
    });
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }

  private send(value: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(value));
    }
  }
}

export function defineAgent<const T extends AgentRecipe>(recipe: T): T {
  if (
    !recipe.name.trim() ||
    recipe.version < 1 ||
    !recipe.instructions.trim()
  ) {
    throw new AgentSDKError("invalid_agent_recipe", 0, "Invalid agent recipe");
  }
  return Object.freeze(recipe);
}

export class MockProvider {
  constructor(private readonly responses: readonly string[]) {}

  async *stream(): AsyncIterable<string> {
    for (const response of this.responses) yield response;
  }
}

async function decode<T>(response: Response): Promise<T> {
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
  return (await response.json()) as T;
}
