# TypeScript mention agent

Requires Node.js 22 or newer. The example uses only the built-in `fetch`, `WebSocket`, and Web Crypto APIs at runtime.

```bash
npm install
export COMA_CORE_URL=http://localhost:8080
export COMA_AGENT_API_KEY=coma_agent_...
export COMA_RUNTIME_CONSUMER=external-ts-example
npm start
```

Mention the agent in one of its chats. It replies in a thread and persists the event sequence before ACKing it. Run `npm run check` to type-check the example.

The implementation calls only operations declared in the repository's [OpenAPI contract](../../../packages/protocol/openapi.yaml) and frames declared in [WebSocket v1](../../../docs/protocols/realtime-v1.md).
