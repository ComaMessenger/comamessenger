import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { buildChatSlot } from "./chatSlot";
import { awaySlot } from "./away";
import { composerMenu, composerMenuItems } from "./composerMenu";
import {
  filterWaitingRows,
  importantCounts,
  importantTabs,
  reduceWaitingInbox,
  waitingFilterCounts,
  waitingFilters,
  waitingList,
  waitingRow,
  waitingSources,
} from "./importantInbox";
import { mentionAwayHints, mentionSuggestionAway } from "./mentions";
import { messageMenu } from "./messageMenu";
import { parsePollEvent, type PollEvent } from "./polls";
import {
  makeAway,
  makePoll,
  makePollMessage,
  makePollViewer,
} from "./pollFixtures";
import { chatHeaderStatus, conversationStatus } from "./presenceText";
import { refreshesUnread, workplaceFeatures } from "./realtime";
import { createMessengerStore, storePollCache } from "./store";
import { makeTask } from "./taskFixtures";
import type { DurableEvent, WaitingInboxItem } from "./types";
import { optimisticPollVote, performPollAction } from "./polls";

const previousTZ = process.env.TZ;
process.env.TZ = "Europe/Berlin";
afterAll(() => {
  process.env.TZ = previousTZ;
});

const now = new Date("2026-11-17T09:00:00Z");
const polls = ["message_requests", "message_tasks", "message_polls"];

let seq = 100;
function durable(
  type: string,
  data: Record<string, unknown>,
  actor: string | null = null,
): DurableEvent {
  seq += 1;
  return {
    op: "event",
    seq,
    type,
    occurred_at: "2026-11-17T09:00:00Z",
    actor_id: actor,
    chat_id: "c1",
    subject_id: String(data.message_id ?? data.actor_id),
    data,
  };
}

const pollUpdated = (overrides: Record<string, unknown> = {}) =>
  durable("poll.updated", {
    message_id: "p1",
    chat_id: "c1",
    status: "open",
    closed_reason: null,
    voter_count: 1,
    member_count: 9,
    final_counts: null,
    version: 2,
    ...overrides,
  });

describe("features and /unread", () => {
  it("knows polls and away", () => {
    expect(workplaceFeatures(["message_polls", "actor_away"])).toMatchObject({
      polls: true,
      away: true,
    });
  });

  it("reads /unread after the reader's vote, a reminder and a closing", () => {
    expect(refreshesUnread(durable("poll.vote.updated", {}))).toBe(true);
    expect(refreshesUnread(durable("poll.notified", {}))).toBe(true);
    expect(refreshesUnread(pollUpdated())).toBe(false);
    expect(refreshesUnread(pollUpdated({ status: "closed" }))).toBe(true);
    const created = (due: string | null) =>
      durable("message.created", {
        ...makePollMessage("p1", makePoll({ due_at: due })),
      } as unknown as Record<string, unknown>);
    expect(refreshesUnread(created("2026-11-18T10:00:00Z"))).toBe(true);
    expect(refreshesUnread(created(null))).toBe(false);
  });
});

describe("composerMenu: «Опрос» (wave 4)", () => {
  it("stands between «Запрос» and «Задача» with its hint", () => {
    const groups = composerMenu({
      platform: "mobile",
      readonly: false,
      hasAgents: false,
      features: polls,
    });
    expect(groups[1]!.items.map((item) => item.id)).toEqual([
      "request",
      "poll",
      "task",
    ]);
    expect(groups[1]!.items[1]).toEqual({
      id: "poll",
      labelKey: "composerPoll",
      hintKey: "composerPollHint",
    });
  });

  it("comes only with message_polls and never in a thread", () => {
    const facts = {
      platform: "web" as const,
      readonly: false,
      hasAgents: false,
    };
    expect(
      composerMenuItems({ ...facts, features: ["message_tasks"] }),
    ).not.toContain("poll");
    expect(
      composerMenuItems({ ...facts, features: polls, inThread: true }),
    ).not.toContain("poll");
    expect(
      composerMenuItems({ ...facts, features: polls, readonly: true }),
    ).toEqual([]);
  });
});

describe("messageMenu of a poll", () => {
  it("has no «Изменить» and no «Сделать задачей», keeps «Напомнить мне»", () => {
    const items = messageMenu({
      own: true,
      canModerate: false,
      canPin: false,
      pinned: false,
      saved: false,
      inThread: false,
      hasText: true,
      persisted: true,
      reminders: true,
      tasks: true,
      messageType: "poll",
    }).flat();
    expect(items).toContain("remind");
    expect(items).not.toContain("edit");
    expect(items).not.toContain("makeTask");
    expect(items).toContain("delete");
  });
});

describe("chatSlot: «Отсутствует»", () => {
  it("stands after «горящего на вас» and before the pinned one", () => {
    const away = awaySlot(
      {
        actor_id: "anna",
        display_name: "Анна Иванова",
        type: "user",
        away: makeAway({ substitute_id: "marina" }),
      },
      { actor_id: "marina", display_name: "Марина Соколова" },
      now,
      "ru",
    );
    const slot = buildChatSlot(
      {
        viewer: { actorID: "me", chatRole: "member" },
        features: polls,
        locale: "ru",
        tasks: [
          {
            id: "t1",
            actor_id: "author",
            created_seq: 1,
            task: makeTask({
              assignee: { ...makeTask().assignee, actor_id: "me" },
              due_at: "2026-11-17T15:00:00Z",
            }),
          },
        ],
        pins: [{ messageID: "pin", text: "Расписание" }],
        scheduled: { count: 0, next: null },
        away,
      },
      now,
    );
    expect(slot.items.map((item) => item.kind)).toEqual([
      "hot",
      "away",
      "pinned",
      "tasks",
    ]);
    expect(slot.items[1]).toMatchObject({
      title: "Вместо Анны — Марина Соколова",
      caption: "Анна в отпуске до 30 ноября",
      emoji: "🌴",
      targetType: "substitute",
      targetActorId: "marina",
    });
  });

  it("is first when nothing burns", () => {
    const slot = buildChatSlot(
      {
        viewer: { actorID: "me", chatRole: "member" },
        features: [],
        locale: "ru",
        pins: [],
        scheduled: { count: 0, next: null },
        away: { title: "Анна в отпуске до 30 ноября", caption: "Отсутствует" },
      },
      now,
    );
    expect(slot.initial).toBe("away");
    expect(slot.items[0]).not.toHaveProperty("targetType");
  });
});

describe("presenceText: away over «в сети»", () => {
  it("shows the away status even when the peer is online", () => {
    expect(
      conversationStatus({
        locale: "ru",
        kind: "direct",
        now,
        actions: [],
        peer: { type: "user", presence: "online", away: makeAway() },
      }),
    ).toEqual({
      text: "🌴 в отпуске до 30 ноября",
      animated: false,
      live: false,
      away: { kind: "vacation", emoji: "🌴" },
    });
  });

  it("keeps «в сети» when the status is planned or over and typing first", () => {
    const planned = makeAway({ starts_at: "2026-11-20T00:00:00Z" });
    expect(
      conversationStatus({
        locale: "ru",
        kind: "direct",
        now,
        actions: [],
        peer: { type: "user", presence: "online", away: planned },
      }).text,
    ).toBe("в сети");
    expect(
      conversationStatus({
        locale: "ru",
        kind: "direct",
        now,
        actions: [{ actorID: "anna", name: "Анна", action: "typing" }],
        peer: { type: "user", presence: "online", away: makeAway() },
      }).text,
    ).toBe("печатает");
  });

  it("takes a fresher away event over the chat's peer", () => {
    const input = {
      locale: "ru" as const,
      now,
      viewerID: "me",
      chat: {
        id: "c1",
        kind: "direct" as const,
        direct_peer: {
          actor_id: "anna",
          type: "user" as const,
          display_name: "Анна",
          away: makeAway(),
        },
      },
      members: [],
      actions: undefined,
      presence: { anna: "online" as const },
      lastSeen: {},
      agentStatuses: [],
    };
    expect(chatHeaderStatus(input).text).toBe("🌴 в отпуске до 30 ноября");
    expect(chatHeaderStatus({ ...input, away: { anna: null } }).text).toBe(
      "в сети",
    );
  });
});

describe("mentions: away", () => {
  const members = [
    {
      actor_id: "11111111-1111-1111-1111-111111111111",
      display_name: "Анна Иванова",
      type: "user" as const,
      away: makeAway({ substitute_id: "22222222-2222-2222-2222-222222222222" }),
    },
    {
      actor_id: "22222222-2222-2222-2222-222222222222",
      display_name: "Марина Соколова",
      type: "user" as const,
    },
  ];

  it("marks someone away in the @ menu", () => {
    expect(mentionSuggestionAway(members[0]!, now, "ru")).toBe(
      "в отпуске до 30 ноября",
    );
    expect(mentionSuggestionAway(members[1]!, now, "ru")).toBeNull();
    expect(
      mentionSuggestionAway(members[0]!, now, "ru", {
        [members[0]!.actor_id]: null,
      }),
    ).toBeNull();
  });

  it("hints for each mentioned person away, with the substitute", () => {
    const source = `@[Анна Иванова](${members[0]!.actor_id}) и @[Марина Соколова](${members[1]!.actor_id}), посмотрите`;
    const hints = mentionAwayHints(source, { members, now, locale: "ru" });
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatchObject({
      actorID: members[0]!.actor_id,
      text: "Анна в отпуске до 30 ноября — ответит позже",
      substitute: { label: "Упомянуть Марину" },
      substituteInChat: true,
    });
    expect(
      mentionAwayHints("без упоминаний", { members, now, locale: "ru" }),
    ).toEqual([]);
  });
});

describe("«Ждут вас» with polls", () => {
  const due = "2026-11-17T15:00:00Z";
  function waitingPoll(id: string, overrides = {}): WaitingInboxItem {
    const message = makePollMessage(
      id,
      makePoll({ due_at: due, ...overrides }),
      {
        poll_viewer: makePollViewer(),
      },
    );
    return {
      kind: "poll",
      message,
      chat_id: "c1",
      author: {
        actor_id: "author",
        display_name: "Вера",
        type: "user",
        avatar_version: 0,
      } as WaitingInboxItem["author"],
      chat: { id: "c1", kind: "group", display_name: "Общий" },
      due_at: due,
      request: null,
      viewer: null,
      my_role: null,
    };
  }

  it("counts polls in the chip and only hot ones in the badge", () => {
    const counts = importantCounts(
      {
        requests_waiting_total: 1,
        reminders_fired_total: 0,
        tasks_mine_open_total: 0,
        tasks_mine_hot_total: 0,
        polls_waiting_total: 3,
        polls_hot_total: 1,
      },
      polls,
    );
    expect(counts).toEqual({ waiting: 4, reminders: 0, badge: 2 });
    expect(
      importantCounts(
        { requests_waiting_total: 0, polls_waiting_total: 3 } as never,
        ["message_requests", "message_tasks"],
      ).waiting,
    ).toBe(0);
    expect(importantTabs(["message_polls"])).toContain("waiting");
  });

  it("offers «Опросы» and reads kind=polls", () => {
    expect(waitingFilters(polls)).toEqual([
      "all",
      "requests",
      "tasks",
      "polls",
    ]);
    expect(waitingSources(polls, "polls")).toEqual([
      { source: "waitingInbox", kind: "polls" },
    ]);
  });

  it("makes rows of polls and keeps only those waiting", () => {
    const row = waitingRow(waitingPoll("p1"));
    expect(row?.kind).toBe("poll");
    const list = waitingList(
      [
        waitingPoll("p1"),
        waitingPoll("p2", { due_at: "2026-11-17T12:00:00Z" }),
      ],
      [],
      "me",
      {
        polls: {
          p1: {
            poll: makePoll({ due_at: due, version: 3 }),
            viewer: {
              version: 3,
              viewer: makePollViewer({ voted: true, can_view_results: true }),
            },
          },
        },
      },
    );
    expect(list.waiting.map((item) => item.item.message.id)).toEqual(["p2"]);
    expect(waitingFilterCounts(list.waiting)).toMatchObject({
      all: 1,
      polls: 1,
      tasks: 0,
    });
    expect(filterWaitingRows(list.waiting, "polls")).toHaveLength(1);
    expect(filterWaitingRows(list.waiting, "tasks")).toHaveLength(0);
  });

  it("drops a poll once voted or closed and reloads on a reminder", () => {
    const event = (raw: DurableEvent) => parsePollEvent(raw) as PollEvent;
    const items = [waitingPoll("p1")];
    const voted = reduceWaitingInbox(
      items,
      event(
        durable("poll.vote.updated", {
          message_id: "p1",
          chat_id: "c1",
          options: [0],
          version: 2,
        }),
      ),
      "me",
      now,
    );
    expect(voted.items).toEqual([]);
    const closed = reduceWaitingInbox(
      items,
      event(pollUpdated({ status: "closed", closed_reason: "author" })),
      "me",
      now,
    );
    expect(closed.items).toEqual([]);
    const counted = reduceWaitingInbox(
      items,
      event(pollUpdated({ voter_count: 4 })),
      "me",
      now,
    );
    expect(counted.items[0]!.message.poll!.voter_count).toBe(4);
    const reminded = reduceWaitingInbox(
      [],
      event(
        durable("poll.notified", {
          message_id: "p9",
          chat_id: "c1",
          kind: "reminded",
        }),
      ),
      "me",
      now,
    );
    expect(reminded.stale).toBe(true);
  });
});

describe("messenger store: polls", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("moves poll_viewer of feed pages into the viewer map", () => {
    const store = createMessengerStore();
    store.getState().replaceMessages("c1", [
      makePollMessage("p1", makePoll(), {
        poll_viewer: makePollViewer({ can_close: true }),
      }),
    ]);
    const state = store.getState();
    expect(state.messages.c1![0]).not.toHaveProperty("poll_viewer");
    expect(state.pollViewers.p1).toEqual({
      version: 1,
      viewer: makePollViewer({ can_close: true }),
    });
  });

  it("applies poll.updated by version and keeps a newer poll over an older page", () => {
    const store = createMessengerStore(100);
    store.getState().replaceMessages("c1", [makePollMessage("p1", makePoll())]);
    store.getState().apply(pollUpdated({ version: 3, voter_count: 2 }));
    store.getState().apply(pollUpdated({ version: 2, voter_count: 1 }));
    expect(store.getState().messages.c1![0]!.poll!.voter_count).toBe(2);
    store.getState().replaceMessages("c1", [makePollMessage("p1", makePoll())]);
    expect(store.getState().messages.c1![0]!.poll!.version).toBe(3);
    // A message.updated frame with the older poll does not undo it either.
    store
      .getState()
      .apply(
        durable(
          "message.updated",
          makePollMessage("p1", makePoll()) as unknown as Record<
            string,
            unknown
          >,
        ),
      );
    expect(store.getState().messages.c1![0]!.poll!.version).toBe(3);
  });

  it("reads getPoll after poll.updated only for a card on screen", async () => {
    vi.useFakeTimers();
    const store = createMessengerStore(100);
    store.getState().replaceMessages("c1", [
      makePollMessage("p1", makePoll(), {
        poll_viewer: makePollViewer({
          voted: true,
          can_view_results: true,
          counts: [1, 0, 0],
        }),
      }),
    ]);
    const loader = vi.fn(async () => ({
      poll: makePoll({ version: 4, voter_count: 3 }),
      viewer: makePollViewer({
        voted: true,
        can_view_results: true,
        counts: [2, 1, 0],
      }),
    }));
    store.getState().setPollLoader(loader);
    store.getState().apply(pollUpdated({ version: 2 }));
    await vi.advanceTimersByTimeAsync(1500);
    expect(loader).not.toHaveBeenCalled();
    const unmount = store.getState().mountPoll("p1");
    store.getState().apply(pollUpdated({ version: 3 }));
    store.getState().apply(pollUpdated({ version: 4, voter_count: 3 }));
    await vi.advanceTimersByTimeAsync(999);
    expect(loader).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(store.getState().pollViewers.p1!.viewer.counts).toEqual([2, 1, 0]);
    unmount();
  });

  it("does not read getPoll for a reader who has not voted", async () => {
    vi.useFakeTimers();
    const store = createMessengerStore(100);
    store
      .getState()
      .replaceMessages("c1", [
        makePollMessage("p1", makePoll(), { poll_viewer: makePollViewer() }),
      ]);
    const loader = vi.fn();
    store.getState().setPollLoader(loader);
    store.getState().mountPoll("p1");
    store.getState().apply(pollUpdated());
    await vi.advanceTimersByTimeAsync(2000);
    expect(loader).not.toHaveBeenCalled();
  });

  it("knows the author for a retraction on another device", () => {
    const store = createMessengerStore(100);
    store.getState().setSelfID("me");
    store.getState().replaceMessages("c1", [
      makePollMessage("p1", makePoll(), {
        actor_id: "me",
        poll_viewer: makePollViewer({
          voted: true,
          my_options: [0],
          can_view_results: true,
          counts: [1, 0, 0],
        }),
      }),
    ]);
    store.getState().apply(
      durable("poll.vote.updated", {
        message_id: "p1",
        chat_id: "c1",
        options: [],
        version: 2,
      }),
    );
    expect(store.getState().pollViewers.p1!.viewer).toMatchObject({
      voted: false,
      can_view_results: true,
    });
  });

  it("votes optimistically through the store and rolls back", async () => {
    const store = createMessengerStore();
    store
      .getState()
      .replaceMessages("c1", [
        makePollMessage("p1", makePoll(), { poll_viewer: makePollViewer() }),
      ]);
    const cache = storePollCache(store, "p1", "c1");
    const optimistic = optimisticPollVote(cache.read(), [1])!;
    await expect(
      performPollAction(cache, optimistic, async () => {
        expect(store.getState().messages.c1![0]!.poll!.voter_count).toBe(1);
        throw new Error("offline");
      }),
    ).rejects.toThrow();
    expect(store.getState().messages.c1![0]!.poll!.voter_count).toBe(0);
    expect(store.getState().pollViewers.p1!.viewer.voted).toBe(false);
  });

  it("keeps away events per person and forgets them on resync", () => {
    const store = createMessengerStore(100);
    store
      .getState()
      .apply(
        durable("actor.away.updated", { actor_id: "anna", away: makeAway() }),
      );
    expect(store.getState().awayOverrides.anna?.kind).toBe("vacation");
    store
      .getState()
      .apply(durable("actor.away.updated", { actor_id: "anna", away: null }));
    expect(store.getState().awayOverrides).toEqual({ anna: null });
    store.getState().resetDurable(500);
    expect(store.getState().awayOverrides).toEqual({});
  });
});
