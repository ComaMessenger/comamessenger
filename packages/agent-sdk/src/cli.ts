#!/usr/bin/env node

import { watch } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
  AgentAdminClient,
  AgentClient,
  AgentSDKError,
  RuntimeSocket,
  runWorker,
  type AgentRecipe,
  type SimulationKind,
} from "./index.js";

void main().catch((error) => {
  reportError(error);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "dev") {
    await dev(process.argv.slice(3));
  } else if (command === "simulate") {
    await simulate(process.argv.slice(3));
  } else {
    usage(command ? `Unknown command: ${command}` : undefined);
  }
}

async function dev(arguments_: string[]): Promise<void> {
  const parsed = parseArgs({
    args: arguments_,
    allowPositionals: true,
    allowNegative: true,
    options: {
      url: { type: "string", default: process.env.COMA_CORE_URL },
      token: { type: "string", default: process.env.COMA_ACCESS_TOKEN },
      "agent-key": {
        type: "string",
        default: process.env.COMA_AGENT_API_KEY,
      },
      chat: { type: "string", multiple: true },
      name: { type: "string" },
      handle: { type: "string" },
      endpoint: { type: "string" },
      concurrency: { type: "string", default: "1" },
      watch: { type: "boolean", default: true },
    },
  });
  const entry = parsed.positionals[0];
  const baseURL = parsed.values.url;
  if (!entry || !baseURL) {
    usage("dev requires a recipe module and --url (or COMA_CORE_URL)");
  }
  const entryPath = resolve(entry);
  let recipe = await loadRecipe(entryPath);
  if (parsed.values.watch) {
    watch(entryPath, { persistent: false }, () => {
      void loadRecipe(entryPath)
        .then((next) => {
          recipe = next;
          output(`Reloaded ${recipe.name} v${recipe.version}`);
        })
        .catch(reportError);
    });
  }
  let apiKey = parsed.values["agent-key"];
  if (!apiKey) {
    const accessToken = parsed.values.token;
    const chatIDs = parsed.values.chat ?? [];
    if (!accessToken || chatIDs.length === 0) {
      usage(
        "provisioning requires --token/COMA_ACCESS_TOKEN and at least one --chat",
      );
    }
    const provisioned = await new AgentAdminClient(
      baseURL,
      accessToken,
    ).provisionExternalAgent(recipe, {
      displayName: parsed.values.name,
      handle: parsed.values.handle,
      endpointURL: parsed.values.endpoint,
      chatIDs,
    });
    apiKey = provisioned.apiKey;
    output(
      `Created ${provisioned.agent.display_name} (@${provisioned.agent.handle})`,
    );
    output(`Agent ID: ${provisioned.agent.id}`);
    output("Runtime key (shown once):");
    output(apiKey);
  }
  const abort = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => abort.abort());
  }
  const client = new AgentClient(baseURL, apiKey);
  const socket = new RuntimeSocket(client, (event) => {
    if (event.op === "error") reportError(event);
  });
  output(`Running ${recipe.name}; waiting for agent runs…`);
  await runWorker({
    client,
    socket,
    recipe: () => recipe,
    concurrency: positiveInteger(parsed.values.concurrency, "concurrency"),
    signal: abort.signal,
    onError: reportError,
  });
  socket.close();
}

async function simulate(arguments_: string[]): Promise<void> {
  const parsed = parseArgs({
    args: arguments_,
    allowPositionals: true,
    options: {
      url: { type: "string", default: process.env.COMA_CORE_URL },
      token: { type: "string", default: process.env.COMA_ACCESS_TOKEN },
      agent: { type: "string" },
      chat: { type: "string" },
      text: { type: "string" },
      command: { type: "string" },
    },
  });
  const kind = parsed.positionals[0] as SimulationKind | undefined;
  if (!kind || !["mention", "command", "schedule"].includes(kind)) {
    usage("simulate requires mention, command, or schedule");
  }
  const { url, token, agent, chat, text, command: commandText } = parsed.values;
  if (!url || !token || !agent || !chat) {
    usage("simulate requires --url, --token, --agent, and --chat");
  }
  const run = await new AgentAdminClient(url, token).simulate({
    agentID: agent,
    chatID: chat,
    kind,
    text,
    command: commandText,
  });
  output(JSON.stringify(run, null, 2));
}

async function loadRecipe(entryPath: string): Promise<AgentRecipe> {
  const moduleURL = pathToFileURL(entryPath);
  moduleURL.searchParams.set("updated", String(Date.now()));
  const imported = (await import(moduleURL.href)) as {
    default?: unknown;
    recipe?: unknown;
  };
  const candidate = imported.default ?? imported.recipe;
  if (!candidate || typeof candidate !== "object") {
    throw new AgentSDKError(
      "agent_recipe_missing",
      0,
      "Recipe module must export default or recipe",
    );
  }
  const recipe = candidate as AgentRecipe;
  if (!recipe.name || !recipe.instructions || !recipe.onRun) {
    throw new AgentSDKError(
      "invalid_agent_recipe",
      0,
      "Development recipes require name, instructions, and onRun",
    );
  }
  return recipe;
}

function positiveInteger(raw: string, name: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 32) {
    throw new AgentSDKError("invalid_argument", 0, `${name} must be 1–32`);
  }
  return value;
}

function reportError(error: unknown): void {
  if (error instanceof AgentSDKError) {
    process.stderr.write(`[${error.code}] ${error.message}\n`);
    return;
  }
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
}

function output(value: string): void {
  process.stdout.write(`${value}\n`);
}

function usage(error?: string): never {
  if (error) process.stderr.write(`${error}\n\n`);
  process.stderr.write(`Usage:
  coma-agent dev <recipe.mjs> --url <core> [--agent-key <key>]
    Provision: --token <admin-token> --chat <uuid> [--chat <uuid>]
    Options:   --name <name> --handle <handle> --concurrency <1-32> --no-watch

  coma-agent simulate <mention|command|schedule> --url <core> --token <admin-token> --agent <uuid> --chat <uuid>
    Options:   --text <text> --command "/name arguments"
`);
  process.exit(1);
}

process.on("uncaughtException", (error) => {
  reportError(error);
  process.exitCode = 1;
});

process.on("unhandledRejection", (error) => {
  reportError(error);
  process.exitCode = 1;
});
