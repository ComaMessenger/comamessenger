/**
 * This file was auto-generated from fixtures/realtime/v1.
 * Do not make direct changes to the file.
 */

import type { components } from "./schema.js";

type Schemas = components["schemas"];

export const realtimeV1Fixtures = {
  "ack": {
    "op": "ack",
    "seq": 1901
  } as const satisfies Schemas["RealtimeAckFrameV1"],
  "auth": {
    "op": "auth",
    "request_id": "0198c17d-2d54-7a83-a19b-4b9a1f07e3b1",
    "access_token": "fixture-access-token",
    "last_seq": 1842
  } as const satisfies Schemas["RealtimeAuthFrameV1"],
  "event": {
    "op": "event",
    "seq": 1901,
    "type": "message.created",
    "occurred_at": "2026-08-18T12:00:00Z",
    "actor_id": "0198c17d-88ba-7ac2-8867-3f71d7722791",
    "chat_id": "0198c17d-a0ac-71f0-aeef-96228a975b85",
    "subject_id": "0198c17d-b55b-78d5-b099-f973dd1f265c",
    "data": {
      "client_msg_id": "0198c17d-c4af-7942-940b-cf0ea670d547",
      "body": "Привет"
    }
  } as const satisfies Schemas["RealtimeDurableEventFrameV1"],
  "hello": {
    "op": "hello",
    "request_id": "0198c17d-2d54-7a83-a19b-4b9a1f07e3b1",
    "connection_id": "0198c17d-5547-76da-be85-33c41f3fa104",
    "current_seq": 1901,
    "min_retained_seq": 1200,
    "heartbeat_interval_ms": 25000,
    "ack_interval_ms": 1000,
    "ack_batch_size": 50,
    "max_unacked_events": 128
  } as const satisfies Schemas["RealtimeHelloFrameV1"],
  "resync-required": {
    "op": "resync_required",
    "current_seq": 250000,
    "min_retained_seq": 150000,
    "reason": "event_history_expired"
  } as const satisfies Schemas["RealtimeResyncRequiredFrameV1"],
  "typing": {
    "op": "typing",
    "actor_id": "0198c17d-88ba-7ac2-8867-3f71d7722791",
    "chat_id": "0198c17d-a0ac-71f0-aeef-96228a975b85",
    "thread_root_id": null,
    "active": true,
    "expires_at": "2026-08-18T12:00:05Z"
  } as const satisfies Schemas["RealtimeTypingEventFrameV1"],
};
