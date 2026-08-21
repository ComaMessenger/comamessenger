# External agent examples

These examples prove that an out-of-process agent can react to mentions without importing Core code or using private endpoints. Both implementations:

1. authenticate with an agent API key;
2. discover their actor ID through `GET /api/v1/me`;
3. load and durably advance a runtime checkpoint;
4. connect to `/api/v1/ws`, resume from that checkpoint, and ACK events;
5. react only to `message.created` events that mention the agent;
6. reply through the published `reply_in_thread` agent tool.

Create and enable an agent in **Settings → Agents**, give it membership in at least one chat, and create a key with `messages:write` and `runtime:execute`. The plaintext key is shown once.

- [TypeScript example](./typescript/README.md)
- [Python example](./python/README.md)
- [Published OpenAPI contract](../../packages/protocol/openapi.yaml)
- [Published WebSocket v1 contract](../../docs/protocols/realtime-v1.md)

Use a distinct `COMA_RUNTIME_CONSUMER` for every independently deployed consumer. A checkpoint is advanced only after the event has been handled successfully. Reply IDs and correlation IDs are deterministic per event, so reconnecting after an uncertain HTTP response does not duplicate the message.
