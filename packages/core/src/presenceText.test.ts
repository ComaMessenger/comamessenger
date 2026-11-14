import { describe, expect, it } from "vitest";
import {
  chatHeaderStatus,
  conversationStatus,
  formatChatActions,
  formatGroupMembers,
  formatLastSeen,
  formatLastSeenApprox,
  pluralCategory,
  type ChatAction,
} from "./presenceText";

// Local time, so the day boundaries match the device's.
const now = new Date(2026, 10, 14, 15, 0, 0);
const ago = (ms: number) => new Date(now.getTime() - ms);
const minute = 60_000;

describe("pluralCategory", () => {
  it("follows Russian rules", () => {
    const cases: Array<[number, string]> = [
      [1, "one"],
      [2, "few"],
      [4, "few"],
      [5, "many"],
      [11, "many"],
      [12, "many"],
      [14, "many"],
      [21, "one"],
      [22, "few"],
      [25, "many"],
      [101, "one"],
      [111, "many"],
      [0, "many"],
    ];
    for (const [count, category] of cases)
      expect(pluralCategory(count, "ru"), String(count)).toBe(category);
  });
  it("follows English rules", () => {
    expect(pluralCategory(1, "en")).toBe("one");
    expect(pluralCategory(2, "en")).toBe("many");
    expect(pluralCategory(0, "en")).toBe("many");
  });
});

describe("formatLastSeen", () => {
  it("says just now under a minute", () => {
    expect(formatLastSeen(ago(30_000), now, "ru")).toBe(
      "был(а) в сети только что",
    );
    expect(formatLastSeen(ago(30_000), now, "en")).toBe("last seen just now");
  });
  it("declines minutes", () => {
    expect(formatLastSeen(ago(1 * minute), now, "ru")).toBe(
      "был(а) в сети 1 минуту назад",
    );
    expect(formatLastSeen(ago(3 * minute), now, "ru")).toBe(
      "был(а) в сети 3 минуты назад",
    );
    expect(formatLastSeen(ago(5 * minute), now, "ru")).toBe(
      "был(а) в сети 5 минут назад",
    );
    expect(formatLastSeen(ago(11 * minute), now, "ru")).toBe(
      "был(а) в сети 11 минут назад",
    );
    expect(formatLastSeen(ago(21 * minute), now, "ru")).toBe(
      "был(а) в сети 21 минуту назад",
    );
    expect(formatLastSeen(ago(1 * minute), now, "en")).toBe(
      "last seen 1 minute ago",
    );
    expect(formatLastSeen(ago(5 * minute), now, "en")).toBe(
      "last seen 5 minutes ago",
    );
  });
  it("names today and yesterday with the time", () => {
    expect(formatLastSeen(new Date(2026, 10, 14, 9, 5), now, "ru")).toBe(
      "был(а) в сети сегодня в 09:05",
    );
    expect(formatLastSeen(new Date(2026, 10, 13, 9, 10), now, "ru")).toBe(
      "был(а) в сети вчера в 09:10",
    );
    expect(formatLastSeen(new Date(2026, 10, 14, 14, 20 - 60), now, "en")).toBe(
      "last seen today at 1:20 PM",
    );
    expect(formatLastSeen(new Date(2026, 10, 13, 0, 5), now, "en")).toBe(
      "last seen yesterday at 12:05 AM",
    );
  });
  it("gives a date further back, with the year when it differs", () => {
    expect(formatLastSeen(new Date(2026, 10, 12, 18, 0), now, "ru")).toBe(
      "был(а) в сети 12 ноября",
    );
    expect(formatLastSeen(new Date(2025, 4, 3, 18, 0), now, "ru")).toBe(
      "был(а) в сети 3 мая 2025",
    );
    expect(formatLastSeen(new Date(2026, 10, 12, 18, 0), now, "en")).toBe(
      "last seen Nov 12",
    );
    expect(formatLastSeen(new Date(2025, 4, 3, 18, 0), now, "en")).toBe(
      "last seen May 3, 2025",
    );
  });
  it("treats a time slightly ahead of the device clock as just now", () => {
    expect(formatLastSeen(new Date(now.getTime() + 20_000), now, "ru")).toBe(
      "был(а) в сети только что",
    );
  });
});

describe("formatLastSeenApprox", () => {
  it("covers every bucket", () => {
    expect(formatLastSeenApprox("recently", "ru")).toBe("был(а) недавно");
    expect(formatLastSeenApprox("within_week", "ru")).toBe(
      "был(а) на этой неделе",
    );
    expect(formatLastSeenApprox("within_month", "ru")).toBe(
      "был(а) в этом месяце",
    );
    expect(formatLastSeenApprox("long_ago", "ru")).toBe("был(а) давно");
    expect(formatLastSeenApprox("recently", "en")).toBe("last seen recently");
  });
});

describe("formatChatActions", () => {
  const anna: ChatAction = { actorID: "a", name: "Анна", action: "typing" };
  const oleg: ChatAction = { actorID: "o", name: "Олег", action: "typing" };
  const ivan: ChatAction = { actorID: "i", name: "Иван", action: "typing" };
  it("drops the name in a direct chat", () => {
    expect(formatChatActions([anna], { direct: true, locale: "ru" })).toBe(
      "печатает",
    );
    for (const [action, text] of [
      ["recording_voice", "записывает голосовое"],
      ["uploading_photo", "отправляет фото"],
      ["uploading_video", "отправляет видео"],
      ["uploading_file", "отправляет файл"],
    ] as const)
      expect(
        formatChatActions([{ ...anna, action }], {
          direct: true,
          locale: "ru",
        }),
      ).toBe(text);
    expect(
      formatChatActions([{ ...anna, action: "recording_voice" }], {
        direct: true,
        locale: "en",
      }),
    ).toBe("recording voice");
  });
  it("names one, two, then several people in a group", () => {
    const group = { direct: false, locale: "ru" as const };
    expect(formatChatActions([anna], group)).toBe("Анна печатает");
    expect(formatChatActions([anna, oleg], group)).toBe("Анна и Олег печатают");
    expect(formatChatActions([anna, oleg, ivan], group)).toBe(
      "Несколько человек печатают",
    );
    expect(
      formatChatActions([{ ...anna, action: "uploading_photo" }], group),
    ).toBe("Анна отправляет фото");
    expect(
      formatChatActions(
        [
          { ...anna, action: "uploading_file" },
          { ...oleg, action: "uploading_file" },
        ],
        group,
      ),
    ).toBe("Анна и Олег отправляют файлы");
    // Different actions fall back to typing.
    expect(
      formatChatActions([{ ...anna, action: "recording_voice" }, oleg], group),
    ).toBe("Анна и Олег печатают");
    const en = { direct: false, locale: "en" as const };
    expect(formatChatActions([anna], en)).toBe("Анна is typing");
    expect(formatChatActions([anna, oleg], en)).toBe(
      "Анна and Олег are typing",
    );
    expect(formatChatActions([anna, oleg, ivan], en)).toBe(
      "Several people are typing",
    );
  });
});

describe("formatGroupMembers", () => {
  it("declines members and adds who is online", () => {
    expect(formatGroupMembers(2, 0, "ru")).toBe("2 участника");
    expect(formatGroupMembers(5, 2, "ru")).toBe("5 участников, 2 в сети");
    expect(formatGroupMembers(21, 1, "ru")).toBe("21 участник, 1 в сети");
    expect(formatGroupMembers(1, 0, "en")).toBe("1 member");
    expect(formatGroupMembers(5, 2, "en")).toBe("5 members, 2 online");
    expect(formatGroupMembers(3, 0, "ru", true)).toBe("3 подписчика");
  });
});

describe("conversationStatus", () => {
  const base = { locale: "ru" as const, now, actions: [] };
  it("shows online, then last seen, then the approximate bucket", () => {
    expect(
      conversationStatus({
        ...base,
        kind: "direct",
        peer: { type: "user", presence: "online" },
      }),
    ).toEqual({ text: "в сети", animated: false, live: true });
    expect(
      conversationStatus({
        ...base,
        kind: "direct",
        peer: {
          type: "user",
          presence: "away",
          lastSeenAt: ago(5 * minute).toISOString(),
        },
      }).text,
    ).toBe("был(а) в сети 5 минут назад");
    expect(
      conversationStatus({
        ...base,
        kind: "direct",
        peer: { type: "user", lastSeenApprox: "within_week" },
      }).text,
    ).toBe("был(а) на этой неделе");
    expect(
      conversationStatus({
        ...base,
        kind: "direct",
        peer: {
          type: "user",
          presence: "offline",
          lastSeenApprox: "within_week",
          seenThisSession: true,
        },
      }).text,
    ).toBe("был(а) недавно");
  });
  it("puts an action above presence", () => {
    expect(
      conversationStatus({
        ...base,
        kind: "direct",
        actions: [{ actorID: "a", name: "Анна", action: "recording_voice" }],
        peer: { type: "user", presence: "online" },
      }),
    ).toEqual({ text: "записывает голосовое", animated: true, live: true });
  });
  it("shows an agent and its run state", () => {
    expect(
      conversationStatus({ ...base, kind: "direct", peer: { type: "agent" } }),
    ).toEqual({ text: "агент", animated: false, live: false });
    expect(
      conversationStatus({
        ...base,
        kind: "direct",
        peer: { type: "agent", agentState: "thinking" },
      }),
    ).toEqual({ text: "агент · думает", animated: true, live: true });
    expect(
      conversationStatus({
        ...base,
        locale: "en",
        kind: "direct",
        peer: { type: "agent", agentState: "completed" },
      }).text,
    ).toBe("agent");
  });
  it("counts group members instead of saying '2 members' in a direct chat", () => {
    expect(
      conversationStatus({
        ...base,
        kind: "group",
        memberCount: 7,
        onlineCount: 3,
      }).text,
    ).toBe("7 участников, 3 в сети");
    expect(
      conversationStatus({
        ...base,
        kind: "group",
        memberCount: 7,
        actions: [
          { actorID: "a", name: "Анна", action: "typing" },
          { actorID: "o", name: "Олег", action: "typing" },
        ],
      }).text,
    ).toBe("Анна и Олег печатают");
  });
});

describe("chatHeaderStatus", () => {
  const members = [
    { actor_id: "me", type: "user" as const, display_name: "Я" },
    { actor_id: "anna", type: "user" as const, display_name: "Анна" },
    { actor_id: "oleg", type: "user" as const, display_name: "Олег" },
    { actor_id: "bot", type: "agent" as const, display_name: "Бот" },
  ];
  const later = now.getTime() + 5000;
  const base = {
    locale: "ru" as const,
    now,
    viewerID: "me",
    members,
    presence: {},
    lastSeen: {},
    agentStatuses: [],
    actions: undefined,
  };
  it("names who acts in a group, without the viewer or stale entries", () => {
    expect(
      chatHeaderStatus({
        ...base,
        chat: { id: "g", kind: "group" },
        actions: {
          me: { action: "typing", expiresAt: later },
          anna: { action: "typing", expiresAt: later },
          oleg: { action: "typing", expiresAt: later },
        },
      }).text,
    ).toBe("Анна и Олег печатают");
    expect(
      chatHeaderStatus({
        ...base,
        chat: { id: "g", kind: "group" },
        actions: { anna: { action: "typing", expiresAt: now.getTime() - 1 } },
        presence: { anna: "online", oleg: "away" },
      }).text,
    ).toBe("4 участника, 2 в сети");
    expect(
      chatHeaderStatus({ ...base, chat: { id: "g", kind: "group" } }).text,
    ).toBe("4 участника");
  });
  it("prefers the last seen from a frame over the REST one", () => {
    const peer = {
      actor_id: "anna",
      type: "user" as const,
      display_name: "Анна",
      last_seen_at: new Date(2026, 10, 12, 10, 0).toISOString(),
    };
    const chat = { id: "d", kind: "direct" as const, direct_peer: peer };
    expect(chatHeaderStatus({ ...base, chat }).text).toBe(
      "был(а) в сети 12 ноября",
    );
    expect(
      chatHeaderStatus({
        ...base,
        chat,
        presence: { anna: "offline" },
        lastSeen: { anna: ago(2 * minute).toISOString() },
      }).text,
    ).toBe("был(а) в сети 2 минуты назад");
  });
  it("shows the agent's run in its direct chat", () => {
    const chat = {
      id: "d",
      kind: "direct" as const,
      direct_peer: {
        actor_id: "bot",
        type: "agent" as const,
        display_name: "Бот",
      },
    };
    expect(
      chatHeaderStatus({
        ...base,
        chat,
        agentStatuses: [
          { actorID: "bot", chatID: "d", threadRootID: null, state: "tool" },
        ],
      }).text,
    ).toBe("агент · выполняет действие");
  });
});
