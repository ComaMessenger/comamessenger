import { MessengerAPI } from "@comamessenger/core";

import { AgentConnectionManager, type SocketLike } from "./connection.js";
import {
  AnthropicProvider,
  OpenAIProvider,
  type Provider,
  type ProviderRequest,
} from "./providers.js";
import { AgentRuntime } from "./runtime.js";

declare const process: {
  env: Record<string, string | undefined>;
  exitCode: number;
  on(signal: "SIGINT" | "SIGTERM", callback: () => void): void;
};

export * from "./connection.js";
export * from "./providers.js";
export * from "./runtime.js";

async function main(): Promise<void> {
  const coreURL = requiredEnvironment("COMA_CORE_URL");
  const agentAPIKey = requiredEnvironment("COMA_AGENT_API_KEY");
  const api = new MessengerAPI(coreURL);
  api.useAccessToken(agentAPIKey);
  const connection = new AgentConnectionManager(
    api,
    process.env.COMA_RUNTIME_CONSUMER ?? "builtin-runtime",
    (url) => new WebSocket(url) as unknown as SocketLike,
    async () => {},
    (error) =>
      console.error(
        JSON.stringify({
          level: "error",
          component: "agent-runtime-websocket",
          code: error.code,
          fatal: error.fatal,
        }),
      ),
  );
  const runtime = new AgentRuntime({
    api,
    provider: providerResolver(api),
    events: connection,
  });
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  connection.start();
  try {
    await runtime.run(shutdown.signal);
  } finally {
    connection.stop();
  }
}

function providerResolver(api: MessengerAPI): (name: string) => Provider {
  return (rawName) => {
    const name = rawName.trim().toLowerCase();
    let provider: Provider;
    if (name === "openai") {
      provider = proxiedProvider(api, name, (fetcher) =>
        new OpenAIProvider(
          "core-managed",
          "https://core.invalid",
          "openai",
          fetcher,
        ),
      );
    } else if (name === "anthropic") {
      provider = proxiedProvider(api, name, (fetcher) =>
        new AnthropicProvider(
          "core-managed",
          "https://core.invalid",
          fetcher,
        ),
      );
    } else if (
      name === "openai-compatible" ||
      name === "openai_compatible" ||
      name === "ollama" ||
      name === "vllm"
    ) {
      provider = proxiedProvider(api, name, (fetcher) =>
        new OpenAIProvider(
          "core-managed",
          "https://core.invalid",
          "openai-compatible",
          fetcher,
        ),
      );
    } else {
      throw new Error("unsupported_provider");
    }
    return provider;
  };
}

function proxiedProvider(
  api: MessengerAPI,
  name: string,
  create: (fetcher: typeof fetch) => Provider,
): Provider {
  return {
    name,
    stream(request: ProviderRequest) {
      const fetcher: typeof fetch = async (_input, init) => {
        const raw = typeof init?.body === "string" ? init.body : "{}";
        return api.agentRuntimeProviderChat(
          {
            call_id: request.callID,
            run_id: request.runID,
            lease_token: request.leaseToken,
            request: JSON.parse(raw) as Record<string, unknown>,
          },
          request.signal,
        );
      };
      return create(fetcher).stream(request);
    },
  };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

void main().catch((cause: unknown) => {
  const message =
    cause instanceof Error ? cause.message : "runtime startup failed";
  console.error(message);
  process.exitCode = 1;
});
