export type ChatRole = "system" | "user" | "assistant" | "tool";

export type ToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type ChatMessage = {
  role: ChatRole;
  content: string;
  toolCallID?: string;
  toolCalls?: ToolCall[];
};

export type ProviderTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type ProviderUsage = {
  inputTokens: number;
  outputTokens: number;
  cost: string;
  currency: string;
  priceSource: "provider" | "configured" | "estimated" | "unknown";
};

export type ProviderRequest = {
  model: string;
  messages: ChatMessage[];
  tools: ProviderTool[];
  maxOutputTokens: number;
  signal: AbortSignal;
};

export type ProviderEvent =
  | { type: "delta"; text: string }
  | {
      type: "finish";
      content: string;
      toolCalls: ToolCall[];
      usage: ProviderUsage;
      stopReason: string;
    };

export interface Provider {
  readonly name: string;
  stream(request: ProviderRequest): AsyncIterable<ProviderEvent>;
}

export class ProviderError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

type Fetcher = typeof fetch;

export class OpenAIProvider implements Provider {
  readonly name: string;
  constructor(
    private readonly apiKey: string,
    private readonly baseURL = "https://api.openai.com/v1",
    name = "openai",
    private readonly fetcher: Fetcher = fetch,
  ) {
    this.name = name;
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    const response = await this.fetcher(
      `${this.baseURL.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        signal: request.signal,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages.map(openAIMessage),
          tools: request.tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            },
          })),
          tool_choice: request.tools.length ? "auto" : undefined,
          ...openAITokenLimit(
            this.name,
            request.model,
            request.maxOutputTokens,
          ),
          stream: true,
          stream_options: { include_usage: true },
        }),
      },
    );
    await ensureProviderOK(response);
    let content = "";
    let usage: Record<string, unknown> = {};
    let stopReason = "";
    const calls = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();
    for await (const payload of readProviderSSE(response)) {
      usage = Object.keys(objectValue(payload.usage)).length
        ? objectValue(payload.usage)
        : usage;
      const choice = objectArray(payload.choices)[0] ?? {};
      stopReason = stringValue(choice.finish_reason) || stopReason;
      const delta = objectValue(choice.delta);
      const text = stringValue(delta.content);
      if (text) {
        content += text;
        yield { type: "delta", text };
      }
      for (const raw of objectArray(delta.tool_calls)) {
        const index = numberValue(raw.index);
        const current = calls.get(index) ?? { id: "", name: "", arguments: "" };
        const fn = objectValue(raw.function);
        current.id += stringValue(raw.id);
        current.name += stringValue(fn.name);
        current.arguments += stringValue(fn.arguments);
        calls.set(index, current);
      }
    }
    const toolCalls = [...calls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call]) => ({
        id: call.id,
        name: call.name,
        arguments: parseArguments(call.arguments),
      }));
    yield {
      type: "finish",
      content,
      toolCalls,
      usage: {
        inputTokens: numberValue(usage.prompt_tokens),
        outputTokens: numberValue(usage.completion_tokens),
        cost: "0",
        currency: "USD",
        priceSource: "unknown",
      },
      stopReason,
    };
  }
}

export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  constructor(
    private readonly apiKey: string,
    private readonly baseURL = "https://api.anthropic.com/v1",
    private readonly fetcher: Fetcher = fetch,
  ) {}

  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    const system = request.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    const response = await this.fetcher(
      `${this.baseURL.replace(/\/$/, "")}/messages`,
      {
        method: "POST",
        signal: request.signal,
        headers: {
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: request.model,
          system,
          messages: anthropicMessages(
            request.messages.filter((message) => message.role !== "system"),
          ),
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
          })),
          max_tokens: request.maxOutputTokens,
          stream: true,
        }),
      },
    );
    await ensureProviderOK(response);
    let content = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason = "";
    const calls = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();
    for await (const payload of readProviderSSE(response)) {
      const type = stringValue(payload.type);
      if (type === "message_start") {
        inputTokens = numberValue(
          objectValue(objectValue(payload.message).usage).input_tokens,
        );
      }
      if (type === "content_block_start") {
        const index = numberValue(payload.index);
        const block = objectValue(payload.content_block);
        if (block.type === "tool_use") {
          calls.set(index, {
            id: stringValue(block.id),
            name: stringValue(block.name),
            arguments: "",
          });
        }
      }
      if (type === "content_block_delta") {
        const index = numberValue(payload.index);
        const delta = objectValue(payload.delta);
        if (delta.type === "text_delta") {
          const text = stringValue(delta.text);
          content += text;
          if (text) yield { type: "delta", text };
        }
        if (delta.type === "input_json_delta") {
          const call = calls.get(index);
          if (call) call.arguments += stringValue(delta.partial_json);
        }
      }
      if (type === "message_delta") {
        stopReason =
          stringValue(objectValue(payload.delta).stop_reason) || stopReason;
        outputTokens = numberValue(objectValue(payload.usage).output_tokens);
      }
    }
    const toolCalls: ToolCall[] = [...calls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call]) => ({
        id: call.id,
        name: call.name,
        arguments: parseArguments(call.arguments || "{}"),
      }));
    yield {
      type: "finish",
      content,
      toolCalls,
      usage: {
        inputTokens,
        outputTokens,
        cost: "0",
        currency: "USD",
        priceSource: "unknown",
      },
      stopReason,
    };
  }
}

function openAIMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallID,
      content: message.content,
    };
  }
  return {
    role: message.role,
    content: message.content || null,
    tool_calls: message.toolCalls?.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    })),
  };
}

function anthropicMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      result.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: message.toolCallID,
            content: message.content,
          },
        ],
      });
      continue;
    }
    const content: Record<string, unknown>[] = [];
    if (message.content) content.push({ type: "text", text: message.content });
    for (const call of message.toolCalls ?? []) {
      content.push({
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: call.arguments,
      });
    }
    result.push({ role: message.role, content });
  }
  return result;
}

async function ensureProviderOK(response: Response): Promise<void> {
  if (!response.ok) {
    const detail = await safeProviderErrorCode(response);
    throw new ProviderError(
      response.status === 429 ? "provider_rate_limited" : "provider_error",
      response.status === 429 || response.status >= 500,
      `Provider returned HTTP ${response.status}${detail ? ` (${detail})` : ""}`,
    );
  }
  if (!response.body) {
    throw new ProviderError(
      "provider_invalid_response",
      false,
      "Provider returned an empty stream",
    );
  }
}

function openAITokenLimit(
  provider: string,
  model: string,
  value: number,
): Record<string, number> {
  if (provider !== "openai") return { max_tokens: value };
  const normalized = model.trim().toLowerCase();
  return /^(?:gpt-5|o[1-9](?:-|$))/.test(normalized)
    ? { max_completion_tokens: value }
    : { max_tokens: value };
}

async function safeProviderErrorCode(response: Response): Promise<string> {
  try {
    const raw = await response.text();
    if (!raw || raw.length > 65_536) return "";
    const payload = JSON.parse(raw) as unknown;
    const error = objectValue(objectValue(payload).error);
    const candidate = stringValue(error.code) || stringValue(error.type);
    return /^[a-zA-Z0-9_.-]{1,120}$/.test(candidate) ? candidate : "";
  } catch {
    return "";
  }
}

async function* readProviderSSE(
  response: Response,
): AsyncIterable<Record<string, unknown>> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 16 * 1024 * 1024) {
      await reader.cancel();
      throw new ProviderError(
        "provider_output_too_large",
        false,
        "Provider stream exceeded its transport limit",
      );
    }
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? "";
    for (const event of events) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data || data === "[DONE]") continue;
      let payload: Record<string, unknown>;
      try {
        payload = objectValue(JSON.parse(data));
      } catch {
        throw new ProviderError(
          "provider_invalid_response",
          false,
          "Provider returned invalid stream JSON",
        );
      }
      if (payload.type === "error" || payload.error) {
        throw new ProviderError(
          "provider_error",
          true,
          "Provider stream returned an error event",
        );
      }
      yield payload;
    }
  }
}

function parseArguments(value: string): Record<string, unknown> {
  try {
    return objectValue(JSON.parse(value));
  } catch {
    throw new ProviderError(
      "provider_invalid_tool_call",
      false,
      "Provider returned invalid tool arguments",
    );
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function objectArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(objectValue) : [];
}
function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
