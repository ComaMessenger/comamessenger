# @comamessenger/agent-sdk

Typed building blocks for external ComaMessenger agent workers: long-poll run claims, leases, tool calls, resumable WebSocket events, bounded streaming and declarative recipes.

```ts
import { AgentClient, defineAgent } from "@comamessenger/agent-sdk";

export const recipe = defineAgent({
  name: "release-notes",
  version: 1,
  instructions: "Summarize verified release changes and cite message IDs.",
  triggers: ["command:/release-notes"],
  tools: ["search_messages", "post_message"],
});

const client = new AgentClient(
  process.env.COMA_CORE_URL!,
  process.env.COMA_AGENT_API_KEY!,
);
const run = await client.claim({ workerID: crypto.randomUUID() });
if (run) await client.complete(run, { handled: true });
```

See [`docs/protocols/agents-v1.md`](../../docs/protocols/agents-v1.md) for the lifecycle and wire contract.
