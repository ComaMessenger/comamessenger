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
          max_tokens: request.maxOutputTokens,
          stream: false,
        }),
      },
    );
    const payload = await readProviderJSON(response);
    const choice = objectArray(payload.choices)[0] ?? {};
    const message = objectValue(choice.message);
    const content = stringValue(message.content);
    if (content) yield { type: "delta", text: content };
    const toolCalls = objectArray(message.tool_calls).map((raw) => {
      const fn = objectValue(raw.function);
      return {
        id: stringValue(raw.id),
        name: stringValue(fn.name),
        arguments: parseArguments(stringValue(fn.arguments)),
      };
    });
    const usage = objectValue(payload.usage);
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
          stream: false,
        }),
      },
    );
    const payload = await readProviderJSON(response);
    let content = "";
    const toolCalls: ToolCall[] = [];
    for (const block of objectArray(payload.content)) {
      if (block.type === "text") content += stringValue(block.text);
      if (block.type === "tool_use") {
        toolCalls.push({
          id: stringValue(block.id),
          name: stringValue(block.name),
          arguments: objectValue(block.input),
        });
      }
    }
    if (content) yield { type: "delta", text: content };
    const usage = objectValue(payload.usage);
    yield {
      type: "finish",
      content,
      toolCalls,
      usage: {
        inputTokens: numberValue(usage.input_tokens),
        outputTokens: numberValue(usage.output_tokens),
        cost: "0",
        currency: "USD",
        priceSource: "unknown",
      },
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

async function readProviderJSON(
  response: Response,
): Promise<Record<string, unknown>> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ProviderError(
      "provider_invalid_response",
      response.status >= 500,
      `Provider returned HTTP ${response.status}`,
    );
  }
  if (!response.ok) {
    throw new ProviderError(
      response.status === 429 ? "provider_rate_limited" : "provider_error",
      response.status === 429 || response.status >= 500,
      `Provider returned HTTP ${response.status}`,
    );
  }
  return objectValue(payload);
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
