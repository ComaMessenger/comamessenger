from __future__ import annotations

import json
import os
import random
import time
import uuid
from typing import Any
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from websockets.sync.client import connect


CORE_URL = os.environ["COMA_CORE_URL"].rstrip("/")
API_KEY = os.environ["COMA_AGENT_API_KEY"].strip()
CONSUMER = os.getenv("COMA_RUNTIME_CONSUMER", "external-python-example")
WS_URL = f"{'wss' if CORE_URL.startswith('https:') else 'ws'}://{CORE_URL.split('://', 1)[1]}/api/v1/ws"


def api(path: str, method: str = "GET", body: Any | None = None) -> Any:
    encoded = None if body is None else json.dumps(body).encode()
    headers = {"Authorization": f"Bearer {API_KEY}"}
    if encoded is not None:
        headers["Content-Type"] = "application/json"
    request = Request(f"{CORE_URL}{path}", data=encoded, headers=headers, method=method)
    try:
        with urlopen(request, timeout=30) as response:
            return json.load(response)
    except HTTPError as error:
        details = error.read().decode(errors="replace")
        raise RuntimeError(f"{method} {path}: {error.code} {details}") from error


def save_checkpoint(seq: int) -> None:
    api(
        f"/api/v1/agent-runtime/checkpoints/{CONSUMER}",
        "PUT",
        {"last_event_seq": seq},
    )


def event_uuid(actor_id: str, label: str) -> str:
    return str(uuid.uuid5(uuid.UUID(actor_id), label))


def is_mention(data: Any, actor_id: str) -> bool:
    return (
        isinstance(data, dict)
        and isinstance(data.get("id"), str)
        and isinstance(data.get("chat_id"), str)
        and data.get("actor_id") != actor_id
        and isinstance(data.get("mentioned_actor_ids"), list)
        and actor_id in data["mentioned_actor_ids"]
    )


def reply(message: dict[str, Any], actor_id: str, seq: int) -> None:
    api(
        "/api/v1/agent-tools/reply_in_thread",
        "POST",
        {
            "arguments": {
                "chat_id": message["chat_id"],
                "client_msg_id": event_uuid(actor_id, f"reply:{seq}"),
                "body": f"I received your mention (message `{message['id']}`).",
                "body_format": "markdown",
                "thread_root_id": message.get("thread_root_id") or message["id"],
                "mentioned_actor_ids": [],
                "file_ids": [],
            },
            "correlation_id": event_uuid(actor_id, f"correlation:{seq}"),
            "confirmed": True,
        },
    )


def connect_once(actor_id: str) -> None:
    checkpoint = api(f"/api/v1/agent-runtime/checkpoints/{CONSUMER}")
    with connect(WS_URL, max_size=262_144, open_timeout=10) as socket:
        socket.send(
            json.dumps(
                {
                    "op": "auth",
                    "request_id": str(uuid.uuid4()),
                    "access_token": API_KEY,
                    "last_seq": checkpoint["last_event_seq"],
                }
            )
        )
        for raw in socket:
            frame = json.loads(raw)
            if frame.get("op") == "hello":
                print(f"Connected as {actor_id}; resume is active.")
                continue
            if frame.get("op") == "resync_required":
                save_checkpoint(int(frame["current_seq"]))
                return
            if frame.get("op") == "error":
                print(f"WebSocket error frame: {frame.get('code', 'unknown')}")
                if frame.get("fatal"):
                    return
                continue
            if frame.get("op") != "event":
                continue

            seq = int(frame["seq"])
            message = frame.get("data")
            if frame.get("type") == "message.created" and is_mention(message, actor_id):
                reply(message, actor_id, seq)
                print(f"Replied to mention {message['id']} at event {seq}.")
            save_checkpoint(seq)
            socket.send(json.dumps({"op": "ack", "seq": seq}))


def main() -> None:
    actor_id = api("/api/v1/me")["id"]
    delay = 0.5
    while True:
        try:
            connect_once(actor_id)
            delay = 0.5
        except KeyboardInterrupt:
            return
        except Exception as error:  # A sample runner should reconnect after transient failures.
            print(error)
        time.sleep(delay + random.random() * 0.25)
        delay = min(30.0, delay * 2)


if __name__ == "__main__":
    main()
