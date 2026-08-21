# @comamessenger/agent-sdk

Typed building blocks for external ComaMessenger agent workers: long-poll run claims, leases, tool calls, resumable WebSocket events, bounded streaming, declarative recipes and the `coma-agent` development CLI.

```ts
import { AgentClient, defineAgent } from "@comamessenger/agent-sdk";

export const recipe = defineAgent({
  name: "release-notes",
  version: 1,
  instructions: "Summarize verified release changes and cite message IDs.",
  triggers: ["command:/release-notes"],
  tools: ["search_messages", "post_message"],
  async onRun(ctx) {
    const command = ctx.command();
    const matches = await ctx.tool("search_messages", {
      query: command?.arguments || "release",
    });
    await ctx.tool("post_message", {
      chat_id: ctx.run.chat_id,
      body: JSON.stringify(matches),
    });
    return { handled: true };
  },
});

const client = new AgentClient(
  process.env.COMA_CORE_URL!,
  process.env.COMA_AGENT_API_KEY!,
);
const run = await client.claim({ workerID: crypto.randomUUID() });
if (run) await client.complete(run, { handled: true });
```

## Local development

Export the recipe as `default` or `recipe` from an ESM module and start a worker with hot reload:

```bash
coma-agent dev ./release-notes.mjs \
  --url http://localhost:8080 \
  --token "$COMA_ACCESS_TOKEN" \
  --chat 00000000-0000-0000-0000-000000000000
```

The first run provisions a disabled external agent, creates a least-privilege runtime key, then enables it only after setup succeeds. The key is printed once. Reuse it on subsequent starts with `--agent-key`.

Trigger a real queued run through the same public contract:

```bash
coma-agent simulate command \
  --url http://localhost:8080 \
  --token "$COMA_ACCESS_TOKEN" \
  --agent 00000000-0000-0000-0000-000000000000 \
  --chat 00000000-0000-0000-0000-000000000000 \
  --command "/release-notes weekly"
```

`simulate` also accepts `mention` and `schedule`. For deterministic tests without an LLM, pass a `MockProvider` to your recipe handler and stream its chunks through `ctx.stream()`.

See [`docs/protocols/agents-v1.md`](../../docs/protocols/agents-v1.md) for the lifecycle and wire contract.
