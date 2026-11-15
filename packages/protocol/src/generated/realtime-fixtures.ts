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
  "event-message-request": {
    "op": "event",
    "seq": 2001,
    "type": "message.created",
    "occurred_at": "2026-11-17T09:00:00Z",
    "actor_id": "0198c17d-88ba-7ac2-8867-3f71d7722791",
    "chat_id": "0198c17d-a0ac-71f0-aeef-96228a975b85",
    "subject_id": "0198c17d-b55b-78d5-b099-f973dd1f265c",
    "data": {
      "id": "0198c17d-b55b-78d5-b099-f973dd1f265c",
      "chat_id": "0198c17d-a0ac-71f0-aeef-96228a975b85",
      "actor_id": "0198c17d-88ba-7ac2-8867-3f71d7722791",
      "client_msg_id": "0198c17d-c4af-7942-940b-cf0ea670d547",
      "type": "request",
      "body": "Планёрка в понедельник. Будете?",
      "body_format": "plain",
      "reply_to_id": null,
      "thread_root_id": null,
      "version": 1,
      "created_seq": 2001,
      "created_at": "2026-11-17T09:00:00Z",
      "edited_at": null,
      "deleted_at": null,
      "mentioned_actor_ids": [],
      "thread_reply_count": 0,
      "files": [],
      "request": {
        "status": "open",
        "closed_reason": null,
        "answer": {
          "preset": "attend"
        },
        "allow_comment": true,
        "due_at": "2026-11-21T15:00:00Z",
        "auto_remind_at": "2026-11-20T15:00:00Z",
        "audience": {
          "kind": "chat",
          "label": "",
          "count": 12
        },
        "answered_count": 0,
        "waiting_count": 12,
        "version": 1
      }
    }
  } as const satisfies Schemas["RealtimeDurableEventFrameV1"] & { data: Schemas["Message"] },
  "event-reminder-created": {
    "op": "event",
    "seq": 2007,
    "type": "reminder.created",
    "occurred_at": "2026-11-17T09:00:00Z",
    "actor_id": "0198c17d-9a31-7d4e-b0f2-5c8e1a7b6d01",
    "chat_id": "0198c17d-a0ac-71f0-aeef-96228a975b85",
    "subject_id": "0198c17d-d2e4-7b19-8c3a-41f6e9a0c7d2",
    "data": {
      "id": "0198c17d-d2e4-7b19-8c3a-41f6e9a0c7d2",
      "message_id": "0198c17d-b55b-78d5-b099-f973dd1f265c",
      "chat_id": "0198c17d-a0ac-71f0-aeef-96228a975b85",
      "remind_at": "2026-11-18T06:00:00Z",
      "state": "pending",
      "version": 1
    }
  } as const satisfies Schemas["RealtimeDurableEventFrameV1"] & { data: Schemas["RealtimeReminderEventV1"] },
  "event-reminder-deleted": {
    "op": "event",
    "seq": 2009,
    "type": "reminder.deleted",
    "occurred_at": "2026-11-17T09:00:00Z",
    "actor_id": "0198c17d-9a31-7d4e-b0f2-5c8e1a7b6d01",
    "chat_id": "0198c17d-a0ac-71f0-aeef-96228a975b85",
    "subject_id": "0198c17d-d2e4-7b19-8c3a-41f6e9a0c7d2",
    "data": {
      "id": "0198c17d-d2e4-7b19-8c3a-41f6e9a0c7d2",
      "message_id": "0198c17d-b55b-78d5-b099-f973dd1f265c",
      "chat_id": "0198c17d-a0ac-71f0-aeef-96228a975b85",
      "remind_at": "2026-11-18T07:00:00Z",
      "state": "pending",
      "version": 3,
      "reason": "message_deleted"
    }
  } as const satisfies Schemas["RealtimeDurableEventFrameV1"] & { data: Schemas["RealtimeReminderEventV1"] },
  "event-reminder-fired": {
    "op": "event",
    "seq": 2010,
    "type": "reminder.fired",
    "occurred_at": "2026-11-17T09:00:00Z",
    "actor_id": "0198c17d-9a31-7d4e-b0f2-5c8e1a7b6d01",
    "chat_id": "0198c17d-a0ac-71f0-aeef-96228a975b85",
    "subject_id": "0198c17d-d2e4-7b19-8c3a-41f6e9a0c7d2",
    "data": {
      "id": "0198c17d-d2e4-7b19-8c3a-41f6e9a0c7d2",
      "message_id": null,
      "chat_id": "0198c17d-a0ac-71f0-aeef-96228a975b85",
      "fired_at": "2026-11-18T07:00:04Z",
      "late": false,
      "version": 3
    }
  } as const satisfies Schemas["RealtimeDurableEventFrameV1"] & { data: Schemas["RealtimeReminderFiredEventV1"] },
  "event-reminder-updated": {
    "op": "event",
    "seq": 2008,
    "type": "reminder.updated",
    "occurred_at": "2026-11-17T09:00:00Z",
    "actor_id": "0198c17d-9a31-7d4e-b0f2-5c8e1a7b6d01",
    "chat_id": "0198c17d-a0ac-71f0-aeef-96228a975b85",
    "subject_id": "0198c17d-d2e4-7b19-8c3a-41f6e9a0c7d2",
    "data": {
      "id": "0198c17d-d2e4-7b19-8c3a-41f6e9a0c7d2",
      "message_id": "0198c17d-b55b-78d5-b099-f973dd1f265c",
      "chat_id": "0198c17d-a0ac-71f0-aeef-96228a975b85",
      "remind_at": "2026-11-18T07:00:00Z",
      "state": "pending",
      "version": 2
    }
  } as const satisfies Schemas["RealtimeDurableEventFrameV1"] & { data: Schemas["RealtimeReminderEventV1"] },
  "event-request-answer-updated": {
    "op": "event",
    "seq": 2004,
    "type": "request.answer.updated",
    "occurred_at": "2026-11-17T09:00:00Z",
    "actor_id": "0198c17d-9a31-7d4e-b0f2-5c8e1a7b6d01",
    "chat_id": "0198c17d-a0ac-71f0-aeef-96228a975b85",
    "subject_id": "0198c17d-b55b-78d5-b099-f973dd1f265c",
    "data": {
      "message_id": "0198c17d-b55b-78d5-b099-f973dd1f265c",
      "chat_id": "0198c17d-a0ac-71f0-aeef-96228a975b85",
      "option": 0,
      "has_comment": true,
      "late": false,
      "version": 2
    }
  } as const satisfies Schemas["RealtimeDurableEventFrameV1"] & { data: Schemas["RealtimeRequestAnswerUpdatedEventV1"] },
  "event-request-assigned": {
    "op": "event",
    "seq": 2000,
    "type": "request.assigned",
    "occurred_at": "2026-11-17T09:00:00Z",
    "actor_id": "0198c17d-88ba-7ac2-8867-3f71d7722791",
    "chat_id": "0198c17d-a0ac-71f0-aeef-96228a975b85",
    "subject_id": "0198c17d-b55b-78d5-b099-f973dd1f265c",
    "data": {
      "message_id": "0198c17d-b55b-78d5-b099-f973dd1f265c",
      "chat_id": "0198c17d-a0ac-71f0-aeef-96228a975b85",
      "due_at": "2026-11-21T15:00:00Z"
    }
  } as const satisfies Schemas["RealtimeDurableEventFrameV1"] & { data: Schemas["RealtimeRequestAssignedEventV1"] },
  "event-request-auto-reminded": {
    "op": "event",
    "seq": 2006,
    "type": "request.auto_reminded",
    "occurred_at": "2026-11-17T09:00:00Z",
    "actor_id": "0198c17d-88ba-7ac2-8867-3f71d7722791",
    "chat_id": "0198c17d-a0ac-71f0-aeef-96228a975b85",
    "subject_id": "0198c17d-b55b-78d5-b099-f973dd1f265c",
    "data": {
      "message_id": "0198c17d-b55b-78d5-b099-f973dd1f265c",
      "chat_id": "0198c17d-a0ac-71f0-aeef-96228a975b85",
      "reminded": 7,
      "answered_count": 5,
      "waiting_count": 7
    }
  } as const satisfies Schemas["RealtimeDurableEventFrameV1"] & { data: Schemas["RealtimeRequestAutoRemindedEventV1"] },
  "event-request-reminded": {
    "op": "event",
    "seq": 2005,
    "type": "request.reminded",
    "occurred_at": "2026-11-17T09:00:00Z",
    "actor_id": "0198c17d-88ba-7ac2-8867-3f71d7722791",
    "chat_id": "0198c17d-a0ac-71f0-aeef-96228a975b85",
    "subject_id": "0198c17d-b55b-78d5-b099-f973dd1f265c",
    "data": {
      "message_id": "0198c17d-b55b-78d5-b099-f973dd1f265c",
      "chat_id": "0198c17d-a0ac-71f0-aeef-96228a975b85",
      "kind": "auto"
    }
  } as const satisfies Schemas["RealtimeDurableEventFrameV1"] & { data: Schemas["RealtimeRequestRemindedEventV1"] },
  "event-request-tally-updated": {
    "op": "event",
    "seq": 2003,
    "type": "request.tally.updated",
    "occurred_at": "2026-11-17T09:00:00Z",
    "actor_id": "0198c17d-9a31-7d4e-b0f2-5c8e1a7b6d01",
    "chat_id": "0198c17d-a0ac-71f0-aeef-96228a975b85",
    "subject_id": "0198c17d-b55b-78d5-b099-f973dd1f265c",
    "data": {
      "message_id": "0198c17d-b55b-78d5-b099-f973dd1f265c",
      "chat_id": "0198c17d-a0ac-71f0-aeef-96228a975b85",
      "tally": [
        4,
        1
      ],
      "waiting_count": 7,
      "version": 6
    }
  } as const satisfies Schemas["RealtimeDurableEventFrameV1"] & { data: Schemas["RealtimeRequestTallyUpdatedEventV1"] },
  "event-request-updated": {
    "op": "event",
    "seq": 2002,
    "type": "request.updated",
    "occurred_at": "2026-11-17T09:00:00Z",
    "actor_id": "0198c17d-9a31-7d4e-b0f2-5c8e1a7b6d01",
    "chat_id": "0198c17d-a0ac-71f0-aeef-96228a975b85",
    "subject_id": "0198c17d-b55b-78d5-b099-f973dd1f265c",
    "data": {
      "message_id": "0198c17d-b55b-78d5-b099-f973dd1f265c",
      "chat_id": "0198c17d-a0ac-71f0-aeef-96228a975b85",
      "status": "open",
      "closed_reason": null,
      "answered_count": 5,
      "waiting_count": 7,
      "version": 6
    }
  } as const satisfies Schemas["RealtimeDurableEventFrameV1"] & { data: Schemas["RealtimeRequestUpdatedEventV1"] },
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
    "max_unacked_events": 128,
    "features": [
      "typing_actions",
      "presence_snapshot",
      "message_requests",
      "message_reminders"
    ]
  } as const satisfies Schemas["RealtimeHelloFrameV1"],
  "presence-snapshot": {
    "op": "presence.snapshot",
    "actors": [
      {
        "actor_id": "0198c17d-88ba-7ac2-8867-3f71d7722791",
        "state": "online",
        "expires_at": "2026-08-18T12:01:00Z"
      }
    ]
  } as const satisfies Schemas["RealtimePresenceSnapshotFrameV1"],
  "presence": {
    "op": "presence",
    "actor_id": "0198c17d-88ba-7ac2-8867-3f71d7722791",
    "state": "offline",
    "expires_at": "2026-08-18T12:00:00Z",
    "last_seen_at": "2026-08-18T12:00:00Z"
  } as const satisfies Schemas["RealtimePresenceEventFrameV1"],
  "resync-required": {
    "op": "resync_required",
    "current_seq": 250000,
    "min_retained_seq": 150000,
    "reason": "event_history_expired"
  } as const satisfies Schemas["RealtimeResyncRequiredFrameV1"],
  "typing-action": {
    "op": "typing",
    "actor_id": "0198c17d-88ba-7ac2-8867-3f71d7722791",
    "chat_id": "0198c17d-a0ac-71f0-aeef-96228a975b85",
    "thread_root_id": null,
    "active": true,
    "action": "recording_voice",
    "expires_at": "2026-08-18T12:00:05Z"
  } as const satisfies Schemas["RealtimeTypingEventFrameV1"],
  "typing": {
    "op": "typing",
    "actor_id": "0198c17d-88ba-7ac2-8867-3f71d7722791",
    "chat_id": "0198c17d-a0ac-71f0-aeef-96228a975b85",
    "thread_root_id": null,
    "active": true,
    "expires_at": "2026-08-18T12:00:05Z"
  } as const satisfies Schemas["RealtimeTypingEventFrameV1"],
};
