import type { AwayPublic, Message, MessagePoll, PollViewer } from "./types";

/** Test helpers for polls and «Отсутствую». */

export function makePoll(overrides: Partial<MessagePoll> = {}): MessagePoll {
  return {
    question: "Когда удобнее субботник?",
    options: ["Среда", "Четверг", "Пятница"],
    multiple: false,
    anonymous: false,
    due_at: null,
    status: "open",
    closed_reason: null,
    closed_at: null,
    voter_count: 0,
    member_count: 9,
    final_counts: null,
    version: 1,
    ...overrides,
  };
}

export function makePollViewer(
  overrides: Partial<PollViewer> = {},
): PollViewer {
  return {
    voted: false,
    my_options: null,
    can_vote: true,
    can_change: false,
    can_view_results: false,
    can_view_voters: false,
    can_view_waiting: false,
    can_close: false,
    can_remind: false,
    next_remind_at: null,
    counts: null,
    ...overrides,
  };
}

export function makePollMessage(
  id: string,
  poll: MessagePoll,
  overrides: Partial<Message> = {},
): Message & { poll: MessagePoll } {
  return {
    id,
    chat_id: "c1",
    actor_id: "author",
    client_msg_id: id,
    type: "poll",
    body: `Опрос: ${poll.question}`,
    body_format: "plain",
    version: 1,
    created_seq: 1,
    created_at: "2026-11-12T08:00:00Z",
    mentioned_actor_ids: [],
    thread_reply_count: 0,
    files: [],
    ...overrides,
    poll,
  } as Message & { poll: MessagePoll };
}

export function makeAway(overrides: Partial<AwayPublic> = {}): AwayPublic {
  return {
    kind: "vacation",
    label: "",
    starts_at: "2026-11-10T00:00:00Z",
    ends_at: "2026-11-30T23:00:00Z",
    active: true,
    substitute_id: null,
    notifications_off: false,
    ...overrides,
  };
}
