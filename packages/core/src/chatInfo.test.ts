import { describe, expect, it } from "vitest";
import {
  chatEventEffect,
  chatRights,
  createChatRequest,
  directChatRequest,
  filterPeople,
  findDirectChat,
  matchesPerson,
  memberRights,
  newChatProblem,
  onlineCount,
  sortChatMembers,
  sortPeople,
  uniquePeople,
  utf8Length,
  type ActorSummary,
  type Chat,
  type ChatMember,
  type ChatViewer,
  type DurableEvent,
} from "./index";

function chat(patch: Partial<Chat> = {}): Chat {
  return {
    id: "c1",
    kind: "group",
    visibility: "private",
    name: "Зал",
    topic: "",
    role: "member",
    created_at: "2026-11-01T10:00:00Z",
    display_name: "Зал",
    avatar_seed: "c1",
    avatar_version: 0,
    notify_level: "default",
    muted_until: null,
    last_activity_seq: 1,
    ...patch,
  } as Chat;
}

function member(
  actorID: string,
  role: ChatMember["role"] = "member",
  patch: Partial<ChatMember> = {},
): ChatMember {
  return {
    actor_id: actorID,
    type: "user",
    display_name: actorID,
    handle: actorID,
    title: "",
    role,
    joined_at: "2026-11-01T10:00:00Z",
    status_emoji: "",
    status_text: "",
    status_expires_at: null,
    avatar_version: 0,
    ...patch,
  } as ChatMember;
}

function actor(
  actorID: string,
  name: string,
  patch: Partial<ActorSummary> = {},
): ActorSummary {
  return {
    actor_id: actorID,
    display_name: name,
    handle: actorID,
    title: "",
    about: "",
    type: "user",
    status_emoji: "",
    status_text: "",
    status_expires_at: null,
    avatar_version: 0,
    ...patch,
  } as ActorSummary;
}

const me: ChatViewer = { actorID: "me", orgRole: "member", permissions: [] };
const moderator: ChatViewer = {
  actorID: "me",
  orgRole: "admin",
  permissions: ["chats.moderate"],
};

describe("chatRights", () => {
  it("lets a plain member only leave", () => {
    expect(chatRights(chat(), me)).toEqual({
      edit: false,
      addMembers: false,
      pin: false,
      leave: true,
      lastOwner: false,
      archive: false,
    });
  });

  it("gives owners and admins the whole chat", () => {
    for (const role of ["owner", "admin"] as const) {
      const rights = chatRights(chat({ role }), me);
      expect(rights.edit && rights.addMembers && rights.pin).toBe(true);
      expect(rights.archive).toBe(true);
    }
  });

  it("lets a workspace moderator add people and archive, not rename", () => {
    const rights = chatRights(chat(), moderator);
    expect(rights.addMembers).toBe(true);
    expect(rights.archive).toBe(true);
    expect(rights.edit).toBe(false);
    expect(rights.pin).toBe(false);
  });

  it("offers nothing in a direct chat", () => {
    const rights = chatRights(
      chat({ kind: "direct", role: "owner" }),
      moderator,
    );
    expect(
      rights.edit || rights.addMembers || rights.leave || rights.archive,
    ).toBe(false);
  });

  it("marks the only owner, who cannot leave", () => {
    const members = [member("me", "owner"), member("b")];
    expect(chatRights(chat({ role: "owner" }), me, members).lastOwner).toBe(
      true,
    );
    expect(
      chatRights(chat({ role: "owner" }), me, [
        ...members,
        member("c", "owner"),
      ]).lastOwner,
    ).toBe(false);
  });
});

describe("memberRights", () => {
  const members = [
    member("me", "admin"),
    member("boss", "owner"),
    member("b"),
    member("bot", "member", { type: "agent" }),
  ];

  it("lets an admin promote and remove members but not touch owners", () => {
    const admin = chat({ role: "admin" });
    expect(memberRights(admin, me, members[2]!, members)).toEqual({
      roles: ["admin"],
      remove: true,
    });
    expect(memberRights(admin, me, members[1]!, members)).toEqual({
      roles: [],
      remove: false,
    });
  });

  it("lets an owner hand over ownership", () => {
    const owned = chat({ role: "owner" });
    const list = [member("me", "owner"), member("b", "admin")];
    expect(memberRights(owned, me, list[1]!, list).roles).toEqual([
      "owner",
      "member",
    ]);
  });

  it("keeps the last owner in place", () => {
    const owned = chat({ role: "owner" });
    const list = [member("me", "owner"), member("boss", "owner")];
    // Two owners: the other one may step down.
    expect(memberRights(owned, me, list[1]!, list).roles).toEqual([
      "admin",
      "member",
    ]);
    const alone = [member("me", "admin"), member("boss", "owner")];
    expect(memberRights(owned, me, alone[1]!, alone)).toEqual({
      roles: [],
      remove: false,
    });
  });

  it("never acts on the reader, nor in a direct chat", () => {
    const admin = chat({ role: "admin" });
    expect(memberRights(admin, me, members[0]!, members).remove).toBe(false);
    expect(
      memberRights(
        chat({ kind: "direct", role: "owner" }),
        me,
        members[2]!,
        members,
      ).remove,
    ).toBe(false);
  });

  it("removes agents without role changes", () => {
    expect(
      memberRights(chat({ role: "admin" }), me, members[3]!, members),
    ).toEqual({ roles: [], remove: true });
  });

  it("gives plain members nothing, moderators non-owners", () => {
    expect(memberRights(chat(), me, members[2]!, members).remove).toBe(false);
    expect(memberRights(chat(), moderator, members[2]!, members)).toEqual({
      roles: ["admin"],
      remove: true,
    });
    expect(memberRights(chat(), moderator, members[1]!, members).remove).toBe(
      false,
    );
  });
});

describe("people search and order", () => {
  const people = [
    actor("a", "Ёлкина Анна", { title: "Инструктор" }),
    actor("b", "Борис", { handle: "boris.k" }),
    actor("bot", "Помощник", { type: "agent" }),
    actor("c", "Вера"),
  ];

  it("finds by name, handle and title, ignoring case, «ё» and «@»", () => {
    expect(matchesPerson(people[0]!, "елкина")).toBe(true);
    expect(matchesPerson(people[0]!, "ИНСТРУКТОР анна")).toBe(true);
    expect(matchesPerson(people[1]!, "@boris")).toBe(true);
    expect(matchesPerson(people[1]!, "вера")).toBe(false);
    expect(matchesPerson(people[1]!, "  ")).toBe(true);
  });

  it("filters by kind, presence and exclusions", () => {
    const presence = { a: "online", b: "away" } as const;
    expect(
      filterPeople(people, { filter: "agents" }).map((p) => p.actor_id),
    ).toEqual(["bot"]);
    expect(
      filterPeople(people, { filter: "online", presence }).map(
        (p) => p.actor_id,
      ),
    ).toEqual(["a"]);
    expect(
      filterPeople(people, { filter: "people", exclude: ["a"] }).map(
        (p) => p.actor_id,
      ),
    ).toEqual(["b", "c"]);
  });

  it("puts online people first and agents last", () => {
    const sorted = sortPeople(people, { c: "online", b: "away" }, "ru");
    expect(sorted.map((p) => p.actor_id)).toEqual(["c", "b", "a", "bot"]);
    expect(onlineCount(people, { c: "online", bot: "online" })).toBe(1);
  });

  it("drops repeated actors across pages", () => {
    expect(uniquePeople([...people, people[0]!]).length).toBe(4);
  });

  it("orders chat members by role, then people before agents", () => {
    const sorted = sortChatMembers(
      [
        member("z"),
        member("bot", "member", { type: "agent", display_name: "a-bot" }),
        member("y", "admin"),
        member("x", "owner"),
      ],
      "ru",
    );
    expect(sorted.map((m) => m.actor_id)).toEqual(["x", "y", "z", "bot"]);
  });
});

describe("creating chats", () => {
  it("builds the request for a group or a channel", () => {
    expect(
      createChatRequest(
        {
          kind: "channel",
          name: "  Новости ",
          topic: " Объявления ",
          open: true,
          memberIDs: ["b", "me", "b", "c"],
        },
        "me",
      ),
    ).toEqual({
      kind: "channel",
      visibility: "public",
      name: "Новости",
      topic: "Объявления",
      member_ids: ["b", "c"],
    });
    expect(
      createChatRequest(
        { kind: "group", name: "x", topic: "", open: false, memberIDs: [] },
        "me",
      ).visibility,
    ).toBe("private");
  });

  it("builds a direct chat request", () => {
    expect(directChatRequest("b")).toEqual({
      kind: "direct",
      visibility: "private",
      name: "",
      topic: "",
      member_ids: ["b"],
    });
  });

  it("measures names in bytes, as the server does", () => {
    expect(utf8Length("abc")).toBe(3);
    expect(utf8Length("зал")).toBe(6);
    expect(utf8Length("👍")).toBe(4);
    expect(newChatProblem({ name: "  ", topic: "" })).toBe("nameRequired");
    expect(newChatProblem({ name: "я".repeat(60), topic: "" })).toBeNull();
    expect(newChatProblem({ name: "я".repeat(61), topic: "" })).toBe(
      "nameTooLong",
    );
    expect(newChatProblem({ name: "x", topic: "ы".repeat(251) })).toBe(
      "topicTooLong",
    );
  });

  it("finds the existing direct chat", () => {
    const direct = chat({
      id: "d",
      kind: "direct",
      direct_peer: actor("b", "Борис"),
    });
    expect(findDirectChat([chat(), direct], "b")?.id).toBe("d");
    expect(findDirectChat([chat(), direct], "c")).toBeUndefined();
  });
});

describe("chatEventEffect", () => {
  const event = (
    type: string,
    chatID: string | null,
    data: Record<string, unknown> = {},
  ): DurableEvent => ({
    op: "event",
    seq: 1,
    type,
    occurred_at: "2026-11-11T10:00:00Z",
    actor_id: "x",
    chat_id: chatID,
    subject_id: "s",
    data,
  });

  it("maps member, pin and chat events to the chat", () => {
    expect(chatEventEffect(event("member.joined", "c1"))).toMatchObject({
      chatID: "c1",
      members: true,
      pins: false,
    });
    expect(chatEventEffect(event("message.unpinned", "c1"))?.pins).toBe(true);
    expect(chatEventEffect(event("chat.updated", "c1"))?.chat).toBe(true);
    // The private copy of a removal names the chat in its data.
    expect(
      chatEventEffect(event("member.removed", null, { chat_id: "c2" }))?.chatID,
    ).toBe("c2");
  });

  it("ignores other events", () => {
    expect(chatEventEffect(event("message.created", "c1"))).toBeNull();
    expect(chatEventEffect(event("member.joined", null))).toBeNull();
  });
});
