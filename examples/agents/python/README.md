# Python mention agent

Requires Python 3.11 or newer and the `websockets` package.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export COMA_CORE_URL=http://localhost:8080
export COMA_AGENT_API_KEY=coma_agent_...
export COMA_RUNTIME_CONSUMER=external-python-example
python agent.py
```

Mention the agent in one of its chats. It replies in a thread and persists the event sequence before ACKing it.

The implementation calls only operations declared in the repository's [OpenAPI contract](../../../packages/protocol/openapi.yaml) and frames declared in [WebSocket v1](../../../docs/protocols/realtime-v1.md).
