import { MessengerAPI } from "@comamessenger/core";

import { AgentConnectionManager, type SocketLike } from "./connection.js";
import {
  AnthropicProvider,
  OpenAIProvider,
  type Provider,
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
    provider: providerResolver(),
    reservedCallCost: process.env.AGENT_RESERVED_CALL_COST ?? "0.01000000",
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

function providerResolver(): (name: string, apiKey?: string) => Provider {
  return (rawName, configuredAPIKey) => {
    const name = rawName.trim().toLowerCase();
    let provider: Provider;
    if (name === "openai") {
      provider = new OpenAIProvider(
        configuredAPIKey ?? requiredEnvironment("OPENAI_API_KEY"),
      );
    } else if (name === "anthropic") {
      provider = new AnthropicProvider(
        configuredAPIKey ?? requiredEnvironment("ANTHROPIC_API_KEY"),
      );
    } else if (
      name === "openai-compatible" ||
      name === "openai_compatible" ||
      name === "ollama" ||
      name === "vllm"
    ) {
      provider = new OpenAIProvider(
        configuredAPIKey ??
          process.env.OPENAI_COMPATIBLE_API_KEY ??
          "local-runtime",
        requiredEnvironment("OPENAI_COMPATIBLE_BASE_URL"),
        "openai-compatible",
      );
    } else {
      throw new Error("unsupported_provider");
    }
    return provider;
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
