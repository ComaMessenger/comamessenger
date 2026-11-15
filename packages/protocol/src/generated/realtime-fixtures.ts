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
  "event-actor-away-cleared": {
    "op": "event",
    "seq": 4021,
    "type": "actor.away.updated",
    "occurred_at": "2026-12-01T00:00:30+03:00",
    "actor_id": "0198c180-3c4d-7e5f-8a6b-7c8d9e0f1a23",
    "chat_id": null,
    "subject_id": "0198c180-3c4d-7e5f-8a6b-7c8d9e0f1a23",
    "data": {
      "actor_id": "0198c180-3c4d-7e5f-8a6b-7c8d9e0f1a23",
      "away": null
    }
  } as const satisfies Schemas["RealtimeDurableEventFrameV1"] & { data: Schemas["RealtimeActorAwayUpdatedEventV1"] },
  "event-actor-away-updated": {
    "op": "event",
    "seq": 4020,
    "type": "actor.away.updated",
    "occurred_at": "2026-11-19T18:00:00Z",
    "actor_id": "0198c180-3c4d-7e5f-8a6b-7c8d9e0f1a23",
    "chat_id": null,
    "subject_id": "0198c180-3c4d-7e5f-8a6b-7c8d9e0f1a23",
    "data": {
      "actor_id": "0198c180-3c4d-7e5f-8a6b-7c8d9e0f1a23",
      "away": {
        "kind": "vacation",
        "label": "",
        "starts_at": "2026-11-20T00:00:00+03:00",
        "ends_at": "2026-12-01T00:00:00+03:00",
        "active": false,
        "substitute_id": "0198c180-5e6f-7a8b-8c9d-9e0f1a2b3c45",
        "notifications_off": true
      }
    }
  } as const satisfies Schemas["RealtimeDurableEventFrameV1"] & { data: Schemas["RealtimeActorAwayUpdatedEventV1"] },
  "event-away-substitute-assigned": {
    "op": "event",
    "seq": 4022,
    "type": "away.substitute.assigned",
    "occurred_at": "2026-11-19T18:00:00Z",
    "actor_id": "0198c180-3c4d-7e5f-8a6b-7c8d9e0f1a23",
    "chat_id": null,
    "subject_id": "0198c180-3c4d-7e5f-8a6b-7c8d9e0f1a23",
    "data": {
      "actor_id": "0198c180-3c4d-7e5f-8a6b-7c8d9e0f1a23",
      "starts_at": "2026-11-20T00:00:00+03:00",
      "ends_at": "2026-12-01T00:00:00+03:00"
    }
  } as const satisfies Schemas["RealtimeDurableEventFrameV1"] & { data: Schemas["RealtimeAwaySubstituteAssignedEventV1"] },
  "event-away-substitute-removed": {
    "op": "event",
    "seq": 4023,
    "type": "away.substitute.removed",
    "occurred_at": "2026-12-01T00:00:30+03:00",
    "actor_id": "0198c180-3c4d-7e5f-8a6b-7c8d9e0f1a23",
    "chat_id": null,
    "subject_id": "0198c180-3c4d-7e5f-8a6b-7c8d9e0f1a23",
    "data": {
      "actor_id": "0198c180-3c4d-7e5f-8a6b-7c8d9e0f1a23"
    }
  } as const satisfies Schemas["RealtimeDurableEventFrameV1"] & { data: Schemas["RealtimeAwaySubstituteRemovedEventV1"] },
  "event-message-auto-reply": {
    "op": "event",
    "seq": 4030,
    "type": "message.created",
    "occurred_at": "2026-11-21T10:00:01Z",
    "actor_id": "0198c180-3c4d-7e5f-8a6b-7c8d9e0f1a23",
    "chat_id": "0198c181-6c7d-7e8f-8a9b-0c1d2e3f4a5b",
    "subject_id": "0198c181-7d8e-7f90-8a1b-2c3d4e5f6a7b",
    "data": {
      "id": "0198c181-7d8e-7f90-8a1b-2c3d4e5f6a7b",
      "chat_id": "0198c181-6c7d-7e8f-8a9b-0c1d2e3f4a5b",
      "actor_id": "0198c180-3c4d-7e5f-8a6b-7c8d9e0f1a23",
      "client_msg_id": "0198c181-8e9f-7a01-8b2c-3d4e5f6a7b8c",
      "type": "text",
      "body": "Я в отпуске до 30 ноября. По срочным вопросам — к Марине Соколовой",
      "body_format": "plain",
      "reply_to_id": null,
      "thread_root_id": null,
      "version": 1,
      "created_seq": 4030,
      "created_at": "2026-11-21T10:00:01Z",
      "edited_at": null,
      "deleted_at": null,
      "mentioned_actor_ids": [],
      "thread_reply_count": 0,
      "files": [],
      "silent": true,
      "auto_reply": true
    }
  } as const satisfies Schemas["RealtimeDurableEventFrameV1"] & { data: Schemas["Message"] },
  "event-message-department-mention": {
    "op": "event",
    "seq": 2101,
    "type": "message.created",
    "occurred_at": "2026-11-17T09:00:00Z",
    "actor_id": "0198c17d-88ba-7ac2-8867-3f71d7722791",
    "chat_id": "0198c17d-a0ac-71f0-aeef-96228a975b85",
    "subject_id": "0198c17e-3c4d-7e5f-a061-7c8d9e0f1a23",
    "data": {
      "id": "0198c17e-3c4d-7e5f-a061-7c8d9e0f1a23",
      "chat_id": "0198c17d-a0ac-71f0-aeef-96228a975b85",
      "actor_id": "0198c17d-88ba-7ac2-8867-3f71d7722791",
      "client_msg_id": "0198c17e-4d5e-7f60-b172-8d9e0f1a2b34",
      "type": "text",
      "body": "@[Зал ЛФК](0198c17e-1a2b-7c3d-8e4f-5a6b7c8d9e01), завтра в 8:30 планёрка",
      "body_format": "plain",
      "reply_to_id": null,
      "thread_root_id": null,
      "version": 1,
      "created_seq": 2101,
      "created_at": "2026-11-17T09:00:00Z",
      "edited_at": null,
      "deleted_at": null,
      "mentioned_actor_ids": [
        "0198c17d-9a31-7d4e-b0f2-5c8e1a7b6d01",
        "0198c17e-2b3c-7d4e-9f50-6b7c8d9e0f12"
      ],
      "thread_reply_count": 0,
      "files": [],
      "mentioned_department_ids": [
        "0198c17e-1a2b-7c3d-8e4f-5a6b7c8d9e01"
      ],
      "mentioned_departments": [
        {
          "department_id": "0198c17e-1a2b-7c3d-8e4f-5a6b7c8d9e01",
          "notified_count": 2
        }
      ]
    }
  } as const satisfies Schemas["RealtimeDurableEventFrameV1"] & { data: Schemas["Message"] },
  "event-message-poll": {
    "op": "event",
    "seq": 4001,
    "type": "message.created",
    "occurred_at": "2026-11-18T09:00:00Z",
    "actor_id": "0198c17d-88ba-7ac2-8867-3f71d7722791",
    "chat_id": "0198c17d-a0ac-71f0-aeef-96228a975b85",
    "subject_id": "0198c181-4a5b-7c6d-8e7f-8091a2b3c4d5",
    "data": {
      "id": "0198c181-4a5b-7c6d-8e7f-8091a2b3c4d5",
      "chat_id": "0198c17d-a0ac-71f0-aeef-96228a975b85",
      "actor_id": "0198c17d-88ba-7ac2-8867-3f71d7722791",
      "client_msg_id": "0198c181-5b6c-7d7e-8f80-91a2b3c4d5e6",
      "type": "poll",
      "body": "Опрос: Когда удобнее субботник?\n\n— Среда\n— Четверг\n— Суббота",
      "body_format": "plain",
      "reply_to_id": null,
      "thread_root_id": null,
      "version": 1,
      "created_seq": 4001,
      "created_at": "2026-11-18T09:00:00Z",
      "edited_at": null,
      "deleted_at": null,
      "mentioned_actor_ids": [],
      "thread_reply_count": 0,
      "files": [],
      "silent": false,
      "poll": {
        "question": "Когда удобнее субботник?",
        "options": [
          "Среда",
          "Четверг",
          "Суббота"
        ],
        "multiple": false,
        "anonymous": true,
        "due_at": "2026-11-20T15:00:00Z",
        "status": "open",
        "closed_reason": null,
        "closed_at": null,
        "voter_count": 0,
        "member_count": 9,
        "final_counts": null,
        "version": 1
      }
    }
  } as const satisfies Schemas["RealtimeDurableEventFrameV1"] & { data: Schemas["Message"] },
  "event-message-request-position": {
    "op": "event",
    "seq": 2102,
    "type": "message.created",
    "occurred_at": "2026-11-17T09:00:00Z",
    "actor_id": "0198c17d-88ba-7ac2-8867-3f71d7722791",
    "chat_id": "0198c17d-a0ac-71f0-aeef-96228a975b85",
    "subject_id": "0198c17e-5e6f-7071-8283-9e0f1a2b3c45",
    "data": {
      "id": "0198c17e-5e6f-7071-8283-9e0f1a2b3c45",
      "chat_id": "0198c17d-a0ac-71f0-aeef-96228a975b85",
      "actor_id": "0198c17d-88ba-7ac2-8867-3f71d7722791",
      "client_msg_id": "0198c17e-6f70-7182-9394-af1a2b3c4d56",
      "type": "request",
      "body": "Все врачи — ознакомьтесь с новым графиком",
      "body_format": "plain",
      "reply_to_id": null,
      "thread_root_id": null,
      "version": 1,
      "created_seq": 2102,
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
          "preset": "ack"
        },
        "allow_comment": true,
        "due_at": null,
        "auto_remind_at": null,
        "audience": {
          "kind": "position",
          "label": "Врач",
          "count": 4,
          "position_id": "0198c17e-7081-7293-a4a5-b02b3c4d5e67"
        },
        "answered_count": 0,
        "waiting_count": 4,
        "version": 1
      }
    }
  } as const satisfies Schemas["RealtimeDurableEventFrameV1"] & { data: Schemas["Message"] },
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
  "event-message-task": {
    "op": "event",
    "seq": 3001,
    "type": "message.created",
    "occurred_at": "2026-11-18T09:00:00Z",
    "actor_id": "0198c17d-88ba-7ac2-8867-3f71d7722791",
    "chat_id": "0198c17d-a0ac-71f0-aeef-96228a975b85",
    "subject_id": "0198c180-1a2b-7c3d-8e4f-5a6b7c8d9e01",
    "data": {
      "id": "0198c180-1a2b-7c3d-8e4f-5a6b7c8d9e01",
      "chat_id": "0198c17d-a0ac-71f0-aeef-96228a975b85",
      "actor_id": "0198c17d-88ba-7ac2-8867-3f71d7722791",
      "client_msg_id": "0198c180-2b3c-7d4e-8f5a-6b7c8d9e0f12",
      "type": "task",
      "body": "Подготовить комнату для новой группы\n\nКровати, бельё, проверить замки.",
      "body_format": "markdown",
      "reply_to_id": null,
      "thread_root_id": null,
      "version": 1,
      "created_seq": 3001,
      "created_at": "2026-11-18T09:00:00Z",
      "edited_at": null,
      "deleted_at": null,
      "mentioned_actor_ids": [],
      "thread_reply_count": 0,
      "files": [],
      "task": {
        "title": "Подготовить комнату для новой группы",
        "description": "Кровати, бельё, проверить замки.",
        "status": "open",
        "canceled_reason": null,
        "status_changed_at": null,
        "status_changed_by": null,
        "assignee": {
          "kind": "person",
          "actor_id": "0198c180-3c4d-7e5f-8a6b-7c8d9e0f1a23",
          "label": "",
          "candidate_ids": [],
          "in_chat": true
        },
        "due_at": "2026-11-19T15:00:00Z",
        "remind_before_due": true,
        "items": [
          {
            "id": "0198c180-4d5e-7f6a-8b7c-8d9e0f1a2b34",
            "text": "Застелить кровати",
            "assignee_id": "0198c180-5e6f-7a8b-8c9d-9e0f1a2b3c45",
            "assignee_in_chat": true,
            "done_at": null,
            "done_by": null
          },
          {
            "id": "0198c180-6f7a-7b8c-8d9e-0f1a2b3c4d56",
            "text": "Проверить замки",
            "assignee_id": null,
            "assignee_in_chat": false,
            "done_at": null,
            "done_by": null
          }
        ],
        "items_done": 0,
        "source": {
          "message_id": "0198c180-7a8b-7c9d-8e0f-1a2b3c4d5e67",
          "author_id": "0198c180-5e6f-7a8b-8c9d-9e0f1a2b3c45",
          "excerpt": "В пятницу заезжает новая группа, комната ещё не готова",
          "deleted": false
        },
        "last_nudge_at": null,
        "nudge_count": 0,
        "version": 1
      }
    }
  } as const satisfies Schemas["RealtimeDurableEventFrameV1"] & { data: Schemas["Message"] },
  "event-org-updated": {
    "op": "event",
    "seq": 2103,
    "type": "org.updated",
    "occurred_at": "2026-11-17T09:05:00Z",
    "actor_id": "0198c17d-9a31-7d4e-b0f2-5c8e1a7b6d01",
    "chat_id": null,
    "subject_id": "0198c17c-0000-7000-8000-000000000001",
    "data": {
      "version": 42,
      "reason": "membership"
    }
  } as const satisfies Schemas["RealtimeDurableEventFrameV1"] & { data: Schemas["RealtimeOrgUpdatedEventV1"] },
  "event-poll-notified": {
    "op": "event",
    "seq": 4005,
    "type": "poll.notified",
    "occurred_at": "2026-11-19T12:00:00Z",
    "actor_id": "0198c17d-88ba-7ac2-8867-3f71d7722791",
    "chat_id": "0198c17d-a0ac-71f0-aeef-96228a975b85",
    "subject_id": "0198c181-4a5b-7c6d-8e7f-8091a2b3c4d5",
    "data": {
      "message_id": "0198c181-4a5b-7c6d-8e7f-8091a2b3c4d5",
      "chat_id": "0198c17d-a0ac-71f0-aeef-96228a975b85",
      "kind": "reminded"
    }
  } as const satisfies Schemas["RealtimeDurableEventFrameV1"] & { data: Schemas["RealtimePollNotifiedEventV1"] },
  "event-poll-updated-open": {
    "op": "event",
    "seq": 4002,
    "type": "poll.updated",
    "occurred_at": "2026-11-18T09:05:00Z",
    "actor_id": null,
    "chat_id": "0198c17d-a0ac-71f0-aeef-96228a975b85",
    "subject_id": "0198c181-4a5b-7c6d-8e7f-8091a2b3c4d5",
    "data": {
      "message_id": "0198c181-4a5b-7c6d-8e7f-8091a2b3c4d5",
      "chat_id": "0198c17d-a0ac-71f0-aeef-96228a975b85",
      "status": "open",
      "closed_reason": null,
      "voter_count": 1,
      "member_count": 9,
      "final_counts": null,
      "version": 2
    }
  } as const satisfies Schemas["RealtimeDurableEventFrameV1"] & { data: Schemas["RealtimePollUpdatedEventV1"] },
  "event-poll-updated": {
    "op": "event",
    "seq": 4010,
    "type": "poll.updated",
    "occurred_at": "2026-11-20T15:00:02Z",
    "actor_id": null,
    "chat_id": "0198c17d-a0ac-71f0-aeef-96228a975b85",
    "subject_id": "0198c181-4a5b-7c6d-8e7f-8091a2b3c4d5",
    "data": {
      "message_id": "0198c181-4a5b-7c6d-8e7f-8091a2b3c4d5",
      "chat_id": "0198c17d-a0ac-71f0-aeef-96228a975b85",
      "status": "closed",
      "closed_reason": "expired",
      "voter_count": 9,
      "member_count": 9,
      "final_counts": [
        5,
        1,
        3
      ],
      "version": 11
    }
  } as const satisfies Schemas["RealtimeDurableEventFrameV1"] & { data: Schemas["RealtimePollUpdatedEventV1"] },
  "event-poll-vote-updated-anonymous": {
    "op": "event",
    "seq": 4004,
    "type": "poll.vote.updated",
    "occurred_at": "2026-11-18T09:05:00Z",
    "actor_id": "0198c180-3c4d-7e5f-8a6b-7c8d9e0f1a23",
    "chat_id": "0198c17d-a0ac-71f0-aeef-96228a975b85",
    "subject_id": "0198c181-4a5b-7c6d-8e7f-8091a2b3c4d5",
    "data": {
      "message_id": "0198c181-4a5b-7c6d-8e7f-8091a2b3c4d5",
      "chat_id": "0198c17d-a0ac-71f0-aeef-96228a975b85",
      "voted": true,
      "version": 2
    }
  } as const satisfies Schemas["RealtimeDurableEventFrameV1"] & { data: Schemas["RealtimePollVoteUpdatedEventV1"] },
  "event-poll-vote-updated": {
    "op": "event",
    "seq": 4003,
    "type": "poll.vote.updated",
    "occurred_at": "2026-11-18T09:05:00Z",
    "actor_id": "0198c180-3c4d-7e5f-8a6b-7c8d9e0f1a23",
    "chat_id": "0198c17d-a0ac-71f0-aeef-96228a975b85",
    "subject_id": "0198c181-9fa0-7b12-8c3d-4e5f6a7b8c9d",
    "data": {
      "message_id": "0198c181-9fa0-7b12-8c3d-4e5f6a7b8c9d",
      "chat_id": "0198c17d-a0ac-71f0-aeef-96228a975b85",
      "options": [
        0,
        2
      ],
      "version": 2
    }
  } as const satisfies Schemas["RealtimeDurableEventFrameV1"] & { data: Schemas["RealtimePollVoteUpdatedEventV1"] },
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
  "event-task-notified": {
    "op": "event",
    "seq": 3002,
    "type": "task.notified",
    "occurred_at": "2026-11-18T09:00:00Z",
    "actor_id": "0198c17d-88ba-7ac2-8867-3f71d7722791",
    "chat_id": "0198c17d-a0ac-71f0-aeef-96228a975b85",
    "subject_id": "0198c180-1a2b-7c3d-8e4f-5a6b7c8d9e01",
    "data": {
      "message_id": "0198c180-1a2b-7c3d-8e4f-5a6b7c8d9e01",
      "chat_id": "0198c17d-a0ac-71f0-aeef-96228a975b85",
      "kind": "assigned",
      "by_actor_id": "0198c17d-88ba-7ac2-8867-3f71d7722791",
      "due_at": "2026-11-19T15:00:00Z"
    }
  } as const satisfies Schemas["RealtimeDurableEventFrameV1"] & { data: Schemas["RealtimeTaskNotifiedEventV1"] },
  "event-task-updated": {
    "op": "event",
    "seq": 3010,
    "type": "task.updated",
    "occurred_at": "2026-11-18T10:30:00Z",
    "actor_id": "0198c180-3c4d-7e5f-8a6b-7c8d9e0f1a23",
    "chat_id": "0198c17d-a0ac-71f0-aeef-96228a975b85",
    "subject_id": "0198c180-8b9c-7d0e-8f1a-2b3c4d5e6f78",
    "data": {
      "message_id": "0198c180-8b9c-7d0e-8f1a-2b3c4d5e6f78",
      "chat_id": "0198c17d-a0ac-71f0-aeef-96228a975b85",
      "task": {
        "title": "Отвезти документы в соцзащиту",
        "description": "",
        "status": "in_progress",
        "canceled_reason": null,
        "status_changed_at": "2026-11-18T10:30:00Z",
        "status_changed_by": "0198c180-3c4d-7e5f-8a6b-7c8d9e0f1a23",
        "assignee": {
          "kind": "department",
          "actor_id": "0198c180-3c4d-7e5f-8a6b-7c8d9e0f1a23",
          "label": "Социальная служба",
          "candidate_ids": [
            "0198c180-3c4d-7e5f-8a6b-7c8d9e0f1a23",
            "0198c180-5e6f-7a8b-8c9d-9e0f1a2b3c45"
          ],
          "in_chat": true,
          "department_id": "0198c180-9cad-7e1f-8a2b-3c4d5e6f7a89"
        },
        "due_at": "2026-11-18T16:00:00Z",
        "remind_before_due": false,
        "items": [],
        "items_done": 0,
        "source": null,
        "last_nudge_at": null,
        "nudge_count": 0,
        "version": 3
      }
    }
  } as const satisfies Schemas["RealtimeDurableEventFrameV1"] & { data: Schemas["TaskUpdatedEvent"] },
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
      "message_reminders",
      "org_structure"
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
