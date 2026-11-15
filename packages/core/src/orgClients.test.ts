import { describe, expect, it } from "vitest";
import { APIError } from "./api";
import {
  decodeMentions,
  departmentMentionNoteText,
  departmentMentionNotes,
  mentionSuggestions,
  mentionedActorIDs,
  mentionedDepartmentIDs,
  messageMentionFields,
  resolvedMentionActorIDs,
} from "./mentions";
import {
  A,
  DOCTOR,
  INSTRUCTOR,
  L,
  P,
  R,
  actor,
  ann,
  boris,
  bot,
  cyril,
  elena,
  nina,
  oleg,
  structure,
  user,
  xenia,
} from "./orgFixture";
import { filterPeople, matchesPerson } from "./people";
import {
  audienceCount,
  audienceSegments,
  emptyRequestDraft,
  requestDraftAudienceText,
  requestErrorKind,
  requestRecipientIDs,
  requestSignature,
  toCreateRequestInput,
} from "./requests";
import {
  canAccessSettingsPage,
  permissionLabelKeys,
  visibleChildSettings,
  visibleSettings,
  workspacePermissions,
} from "./settings";
import type { ChatMember, OrganizationMember } from "./types";
import { memberGrantablePermissions, memberRules } from "./workspace";

function chatMember(id: string, name: string, type: "user" | "agent" = "user") {
  return {
    actor_id: id,
    display_name: name,
    handle: name.toLowerCase(),
    type,
  } satisfies Pick<ChatMember, "actor_id" | "display_name" | "handle" | "type">;
}

const departmentIDs = [R, L, P, A];

describe("mentions of departments", () => {
  const body = `@[Зал ЛФК](${L}) и @[Олег](${oleg}), @[Зал ЛФК](${L}) ещё раз`;

  it("tells departments from people by id", () => {
    expect(mentionedActorIDs(body, departmentIDs)).toEqual([oleg]);
    expect(mentionedDepartmentIDs(body, departmentIDs)).toEqual([L]);
    // Without the ids (no org_structure) the token is a plain mention.
    expect(mentionedActorIDs(body)).toEqual([L, oleg]);
    // The visible text is the same as for a person.
    expect(decodeMentions(body).text).toBe(
      "@Зал ЛФК и @Олег, @Зал ЛФК ещё раз",
    );
  });

  it("keeps departments out of @all", () => {
    const members = [{ actor_id: oleg }, { actor_id: boris }];
    expect(
      resolvedMentionActorIDs(
        `@all @[Зал ЛФК](${L})`,
        members,
        {},
        departmentIDs,
      ),
    ).toEqual([oleg, boris]);
  });

  it("fills the message fields only with the structure", () => {
    const members = [{ actor_id: oleg }];
    expect(
      messageMentionFields(body, {
        members,
        presence: {},
        structure: structure(),
      }),
    ).toEqual({ mentioned_actor_ids: [oleg], mentioned_department_ids: [L] });
    expect(messageMentionFields(body, { members, presence: {} })).toEqual({
      mentioned_actor_ids: [L, oleg],
    });
    expect(
      messageMentionFields(`@[Олег](${oleg})`, {
        members,
        presence: {},
        structure: structure(),
      }),
    ).toEqual({ mentioned_actor_ids: [oleg] });
  });
});

describe("@ suggestions", () => {
  const members = [
    chatMember(ann, "Анна"),
    chatMember(boris, "Борис"),
    chatMember(cyril, "Кирилл"),
    chatMember(bot, "Бот", "agent"),
  ];

  it("offers departments with people of this chat first", () => {
    const result = mentionSuggestions("", {
      members,
      authorID: ann,
      structure: structure(),
    });
    // Администрация has only Elena, who is not in the chat; Реабилитация
    // counts Boris and Cyril (Anna is the author).
    expect(
      result.departments.map((item) => [
        item.department.name,
        item.inChatCount,
      ]),
    ).toEqual([
      ["Реабилитация", 2],
      ["Бассейн", 1],
      ["Зал ЛФК", 2],
    ]);
    expect(result.departments[2]!.path).toBe("Реабилитация");
    expect(result.people.map((item) => item.actor_id)).toEqual([
      ann,
      boris,
      cyril,
      bot,
    ]);
    expect(result.context).toEqual(["all", "here"]);
  });

  it("hides a department whose only member in the chat is the author", () => {
    const result = mentionSuggestions("", {
      members: [chatMember(oleg, "Олег"), chatMember(xenia, "Ксения")],
      authorID: oleg,
      structure: structure(),
    });
    expect(result.departments).toEqual([]);
  });

  it("filters every section by the query, «ё» as «е»", () => {
    const result = mentionSuggestions("зал", {
      members,
      authorID: ann,
      structure: structure(),
    });
    expect(result.departments.map((item) => item.department.id)).toEqual([L]);
    expect(result.people).toEqual([]);
    expect(result.context).toEqual([]);
    expect(
      mentionSuggestions("he", { members, authorID: ann }).context,
    ).toEqual(["here"]);
    expect(mentionSuggestions("бо", { members, authorID: ann })).toMatchObject({
      departments: [],
      people: [
        expect.objectContaining({ actor_id: boris }),
        expect.objectContaining({ actor_id: bot }),
      ],
    });
  });
});

describe("«Уведомлены N человек»", () => {
  const message = {
    actor_id: oleg,
    body: `@[Старое имя](${L}) @[Удалённый](${P})`,
    mentioned_departments: [
      { department_id: L, notified_count: 5 },
      { department_id: P, notified_count: 0 },
    ],
  };

  it("is shown to the author only", () => {
    expect(departmentMentionNotes(message, boris, structure())).toEqual([]);
    const notes = departmentMentionNotes(
      message,
      oleg,
      structure((value) => {
        value.departments = value.departments.filter((item) => item.id !== P);
      }),
    );
    expect(notes).toEqual([
      { departmentID: L, name: "Зал ЛФК", notifiedCount: 5 },
      { departmentID: P, name: "Удалённый", notifiedCount: 0 },
    ]);
    expect(notes.map((note) => departmentMentionNoteText(note, "ru"))).toEqual([
      "Уведомлены 5 человек из отдела «Зал ЛФК»",
      "Никого из отдела «Удалённый» нет в этом чате",
    ]);
    expect(
      departmentMentionNoteText(
        { departmentID: L, name: "Зал ЛФК", notifiedCount: 1 },
        "ru",
      ),
    ).toBe("Уведомлён 1 человек из отдела «Зал ЛФК»");
    expect(
      departmentMentionNoteText(
        { departmentID: L, name: "Зал ЛФК", notifiedCount: 3 },
        "ru",
      ),
    ).toBe("Уведомлены 3 человека из отдела «Зал ЛФК»");
    expect(
      departmentMentionNoteText(
        { departmentID: L, name: "Gym", notifiedCount: 2 },
        "en",
      ),
    ).toBe("2 people from Gym notified");
    expect(
      departmentMentionNotes(
        { ...message, mentioned_departments: undefined },
        oleg,
      ),
    ).toEqual([]);
  });
});

describe("people search with the structure", () => {
  const people = [
    actor(ann, "Анна Петрова"),
    actor(oleg, "Олег Чернов"),
    actor(cyril, "Кирилл Аксёнов"),
    actor(xenia, "Ксения", { position_id: DOCTOR }),
  ];

  it("finds by position and by any department, «ё» as «е»", () => {
    const value = structure();
    expect(
      filterPeople(people, { query: "инструктор", structure: value }).map(
        (item) => item.actor_id,
      ),
    ).toEqual([oleg, cyril]);
    // Cyril is a part-timer in Зал ЛФК.
    expect(
      filterPeople(people, { query: "зал лфк", structure: value }).map(
        (item) => item.actor_id,
      ),
    ).toEqual([oleg, cyril]);
    expect(matchesPerson(people[2]!, "аксенов бассейн", value)).toBe(true);
    // Without the structure only the name, the handle and the caption.
    expect(matchesPerson(people[1]!, "инструктор")).toBe(false);
    // The position from ActorSummary when the person is not in the structure.
    expect(matchesPerson(people[3]!, "врач", value)).toBe(true);
  });
});

describe("settings for the org structure", () => {
  const features = ["org_structure"];

  it("lists the new permissions with labels", () => {
    expect(workspacePermissions).toContain("org.manage");
    expect(workspacePermissions).toContain("requests.address_groups");
    expect(permissionLabelKeys["org.manage"]).toBe("permissionOrgManage");
    expect(memberGrantablePermissions).toEqual([
      "knowledge.manage",
      "org.manage",
      "requests.address_groups",
    ]);
  });

  it("shows «Оргструктура» with org.manage or members.manage and the feature", () => {
    expect(
      canAccessSettingsPage(
        user("member", ["org.manage"]),
        "workspace-org",
        features,
      ),
    ).toBe(true);
    expect(
      canAccessSettingsPage(
        user("admin", ["members.manage"]),
        "workspace-org",
        features,
      ),
    ).toBe(true);
    expect(
      canAccessSettingsPage(
        user("member", ["knowledge.manage"]),
        "workspace-org",
        features,
      ),
    ).toBe(false);
    expect(canAccessSettingsPage(user("owner"), "workspace-org")).toBe(false);
    expect(
      canAccessSettingsPage(user("owner"), "workspace-org", features),
    ).toBe(true);
    // org.manage alone opens the workspace section to reach it.
    const keeper = user("member", ["org.manage"]);
    expect(
      visibleSettings(keeper, features).map((entry) => entry.id),
    ).toContain("workspace");
    expect(
      visibleChildSettings(keeper, "workspace", features).map(
        (entry) => entry.id,
      ),
    ).toEqual(["workspace-org"]);
    expect(visibleChildSettings(keeper, "workspace")).toEqual([]);
  });
});

describe("member permission switches (decision 15)", () => {
  function member(
    role: OrganizationMember["role"],
    permissions: OrganizationMember["permissions"] = [],
    status: OrganizationMember["status"] = "active",
  ): OrganizationMember {
    return {
      actor_id: boris,
      email: "boris@example.test",
      display_name: "Борис",
      handle: "boris",
      title: "",
      role,
      status,
      permissions,
      created_at: "2026-08-21T00:00:00Z",
    } as OrganizationMember;
  }
  const features = ["org_structure"];
  const toggles = (
    actorRole: "owner" | "admin",
    held: Parameters<typeof user>[1],
    target = member("member"),
  ) =>
    Object.fromEntries(
      memberRules(user(actorRole, held), target, {
        features,
      }).memberPermissions.map((item) => [item.code, item.enabled]),
    );

  it("lets the owner switch every member permission", () => {
    expect(toggles("owner", [])).toEqual({
      "knowledge.manage": true,
      "org.manage": true,
      "requests.address_groups": true,
    });
  });

  it("lets an administrator switch only what they hold", () => {
    expect(
      toggles("admin", ["members.manage", "knowledge.manage", "org.manage"]),
    ).toEqual({
      "knowledge.manage": true,
      "org.manage": true,
      "requests.address_groups": false,
    });
    expect(toggles("admin", ["knowledge.manage", "org.manage"])).toEqual({
      "knowledge.manage": false,
      "org.manage": false,
      "requests.address_groups": false,
    });
  });

  it("reports what the member holds and hides newer switches on old servers", () => {
    const rules = memberRules(user("owner"), member("member", ["org.manage"]), {
      features,
    });
    expect(
      rules.memberPermissions.find((item) => item.code === "org.manage")
        ?.granted,
    ).toBe(true);
    expect(
      memberRules(user("owner"), member("member")).memberPermissions.map(
        (item) => item.code,
      ),
    ).toEqual(["knowledge.manage"]);
  });

  it("has no member switches for administrators, oneself or the deactivated", () => {
    expect(
      memberRules(user("owner"), member("admin"), { features })
        .memberPermissions,
    ).toEqual([]);
    expect(toggles("owner", [], member("member", [], "deactivated"))).toEqual({
      "knowledge.manage": false,
      "org.manage": false,
      "requests.address_groups": false,
    });
    const self = { ...member("member"), actor_id: ann };
    expect(
      memberRules(user("member", ["members.manage"]), self, { features })
        .memberPermissions,
    ).toEqual([]);
  });
});

describe("request audience segments", () => {
  const both = ["message_requests", "org_structure"];

  it("offers «Отдел» and «Должность» with both features and the right", () => {
    expect(audienceSegments(user("owner"), both)).toEqual([
      "chat",
      "people",
      "department",
      "position",
    ]);
    expect(
      audienceSegments(user("member", ["requests.address_groups"]), both),
    ).toEqual(["chat", "people", "department", "position"]);
    expect(audienceSegments(user("admin", ["members.manage"]), both)).toEqual([
      "chat",
      "people",
    ]);
    expect(audienceSegments(user("owner"), ["message_requests"])).toEqual([
      "chat",
      "people",
    ]);
    expect(audienceSegments(user("owner"), ["org_structure"])).toEqual([
      "chat",
      "people",
    ]);
    expect(
      audienceSegments(
        user("owner"),
        both,
        structure((value) => {
          value.positions = [];
        }),
      ),
    ).toEqual(["chat", "people", "department"]);
  });

  it("counts «Ждём от N человек» for a department and a position", () => {
    const members = [
      { actor_id: ann, type: "user" as const },
      { actor_id: oleg, type: "user" as const },
      { actor_id: cyril, type: "user" as const },
      { actor_id: nina, type: "user" as const },
      { actor_id: elena, type: "user" as const },
      { actor_id: bot, type: "agent" as const },
    ];
    const value = structure();
    // Реабилитация: Anna is the author; Elena, Cyril, Oleg are in the chat.
    expect(
      audienceCount(
        { kind: "department", departmentID: R },
        value,
        members,
        ann,
      ),
    ).toBe(3);
    expect(
      audienceCount(
        { kind: "department", departmentID: L },
        value,
        members,
        ann,
      ),
    ).toBe(2);
    expect(
      audienceCount(
        { kind: "position", positionID: DOCTOR },
        value,
        members,
        ann,
      ),
    ).toBe(1);
    expect(
      audienceCount(
        { kind: "position", positionID: INSTRUCTOR },
        value,
        members,
        oleg,
      ),
    ).toBe(1);
    expect(
      audienceCount(
        { kind: "department", departmentID: R },
        null,
        members,
        ann,
      ),
    ).toBe(0);
    expect(audienceCount({ kind: "chat" }, value, members, ann)).toBe(4);
    expect(
      requestRecipientIDs(
        { kind: "department", departmentID: L },
        members,
        ann,
        value,
      ),
    ).toEqual([oleg, cyril]);
  });

  it("sends the department or position and labels the draft", () => {
    const now = new Date("2026-11-15T09:00:00Z");
    const draft = {
      ...emptyRequestDraft(),
      body: "Кто завтра?",
      audience: { kind: "department" as const, departmentID: L },
    };
    const input = toCreateRequestInput(draft, "c1", now, {
      mentionedDepartmentIDs: [P],
    });
    expect(input.audience).toEqual({ kind: "department", department_id: L });
    expect(input.mentioned_department_ids).toEqual([P]);
    const position = toCreateRequestInput(
      { ...draft, audience: { kind: "position", positionID: DOCTOR } },
      "c1",
      now,
    );
    expect(position.audience).toEqual({
      kind: "position",
      position_id: DOCTOR,
    });
    expect(position.mentioned_department_ids).toBeUndefined();
    expect(requestSignature(input)).not.toBe(
      requestSignature({
        ...input,
        audience: { kind: "department", department_id: P },
      }),
    );
    expect(requestDraftAudienceText(draft.audience, structure(), "ru")).toBe(
      "отдел «Зал ЛФК»",
    );
    expect(
      requestDraftAudienceText(
        { kind: "position", positionID: DOCTOR },
        structure(),
        "ru",
      ),
    ).toBe("должность «Врач»");
    expect(
      requestDraftAudienceText(
        { kind: "people", actorIDs: [oleg, cyril, ann] },
        null,
        "ru",
      ),
    ).toBe("3 человека");
  });

  it("names the new errors", () => {
    expect(
      requestErrorKind(new APIError(403, "request_audience_forbidden", "")),
    ).toBe("audienceForbidden");
    expect(
      requestErrorKind(new APIError(404, "department_not_found", "")),
    ).toBe("audienceGone");
    expect(requestErrorKind(new APIError(404, "position_not_found", ""))).toBe(
      "audienceGone",
    );
  });
});
