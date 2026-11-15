import { describe, expect, it, vi } from "vitest";
import {
  buildOrgTree,
  canAddressGroups,
  canManageOrg,
  createOrgSync,
  departmentChatState,
  departmentCount,
  departmentDeletionTargets,
  departmentMoves,
  departmentParentOptions,
  departmentPath,
  departmentPeople,
  expandDepartment,
  expandPosition,
  fetchOrgStructure,
  flattenOrgTree,
  groupPeopleByDepartment,
  managerOf,
  orgEventEffect,
  orgIndex,
  orgKeys,
  orgStructureAvailable,
  personOrg,
  personOrgLine,
  searchOrg,
  showsOrgEntry,
  subordinatesOf,
} from "./org";
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
  department,
  elena,
  nina,
  oleg,
  person,
  structure,
  user,
  xenia,
} from "./orgFixture";

describe("org tree", () => {
  it("orders siblings by name, manual order first", () => {
    const tree = buildOrgTree(structure());
    expect(tree.map((node) => node.department.name)).toEqual([
      "Администрация",
      "Реабилитация",
    ]);
    expect(tree[1]!.children.map((node) => node.department.name)).toEqual([
      "Бассейн",
      "Зал ЛФК",
    ]);
    expect(tree[1]!.children[0]!.depth).toBe(1);

    const manual = buildOrgTree(
      structure((value) => {
        value.departments[0]!.sort_key = 1; // Зал ЛФК
        value.departments[2]!.sort_key = 2; // Бассейн
      }),
    );
    expect(manual[1]!.children.map((node) => node.department.name)).toEqual([
      "Зал ЛФК",
      "Бассейн",
    ]);

    // A department added after the manual order goes after the ordered ones.
    const added = buildOrgTree(
      structure((value) => {
        value.departments[0]!.sort_key = 1;
        value.departments.push(department(person(9), "Аквааэробика", R, null));
      }),
    );
    expect(added[1]!.children.map((node) => node.department.name)).toEqual([
      "Зал ЛФК",
      "Аквааэробика",
      "Бассейн",
    ]);
  });

  it("counts people with subdepartments without repeating a part-timer", () => {
    const value = structure();
    expect(departmentCount(value, R)).toBe(5);
    expect(departmentCount(value, R, { nested: false })).toBe(2);
    expect(departmentCount(value, L)).toBe(3);
    const tree = buildOrgTree(value);
    expect(tree[1]!.count).toBe(5);
    expect(tree[1]!.directCount).toBe(2);
    expect(departmentPeople(value, L)).toEqual([oleg, boris, cyril]);
  });

  it("flattens expanded rows", () => {
    const tree = buildOrgTree(structure());
    expect(
      flattenOrgTree(tree, new Set()).map((row) => row.node.department.id),
    ).toEqual([A, R]);
    const rows = flattenOrgTree(tree, new Set([R]));
    expect(rows.map((row) => row.node.department.id)).toEqual([A, R, P, L]);
    expect(rows[1]).toMatchObject({ hasChildren: true, expanded: true });
    expect(rows[0]).toMatchObject({ hasChildren: false, expanded: false });
    expect(flattenOrgTree(tree, "all")).toHaveLength(4);
  });

  it("survives a missing parent and a cycle", () => {
    const orphan = structure((value) => {
      value.departments.push(department(person(9), "Сироты", "missing", null));
    });
    expect(buildOrgTree(orphan).map((node) => node.department.name)).toContain(
      "Сироты",
    );
    const cycle = structure((value) => {
      value.departments.push(
        department(
          person(9),
          "Первый",
          "20000000-0000-4000-8000-000000000010",
          null,
        ),
        department(
          "20000000-0000-4000-8000-000000000010",
          "Второй",
          person(9),
          null,
        ),
      );
    });
    expect(orgIndex(cycle).order).toHaveLength(6);
    expect(departmentPath(cycle, person(9))).toContain("Первый");
  });

  it("builds the path", () => {
    const value = structure();
    expect(departmentPath(value, L)).toBe("Реабилитация › Зал ЛФК");
    expect(departmentPath(value, L, { includeSelf: false })).toBe(
      "Реабилитация",
    );
    expect(departmentPath(value, R, { includeSelf: false })).toBe("");
    expect(departmentPath(value, "missing")).toBe("");
  });
});

describe("managers and subordinates", () => {
  it("finds the lead of the primary department", () => {
    expect(managerOf(structure(), boris)).toBe(oleg);
  });

  it("goes to the parent for the lead themselves", () => {
    expect(managerOf(structure(), oleg)).toBe(ann);
  });

  it("goes up when the department has no lead", () => {
    expect(managerOf(structure(), cyril)).toBe(ann);
  });

  it("has none at the top and outside the structure", () => {
    expect(managerOf(structure(), ann)).toBeNull();
    expect(managerOf(structure(), nina)).toBeNull();
    expect(managerOf(structure(), xenia)).toBeNull();
  });

  it("skips a lead who is not active", () => {
    // The server sends null for an inactive lead…
    const nulled = structure((value) => {
      value.departments[0]!.lead_actor_id = null;
    });
    expect(managerOf(nulled, boris)).toBe(ann);
    // …and a lead missing from people is not active either.
    const gone = structure((value) => {
      value.people = value.people.filter((item) => item.actor_id !== oleg);
    });
    expect(managerOf(gone, boris)).toBe(ann);
    expect(subordinatesOf(gone, ann)).toEqual([elena]);
  });

  it("lists subordinates", () => {
    expect(subordinatesOf(structure(), ann)).toEqual([elena, oleg]);
    expect(subordinatesOf(structure(), oleg)).toEqual([boris, cyril]);
    expect(subordinatesOf(structure(), boris)).toEqual([]);
  });

  it("describes a person", () => {
    const org = personOrg(structure(), cyril);
    expect(org.primary?.id).toBe(P);
    expect(org.additional.map((item) => item.id)).toEqual([L]);
    expect(org.position?.name).toBe("Инструктор");
    expect(personOrg(structure(), ann).leads.map((item) => item.id)).toEqual([
      R,
    ]);
    expect(personOrg(structure(), xenia)).toEqual({
      primary: null,
      additional: [],
      position: null,
      leads: [],
    });
  });
});

describe("expanding for a preview", () => {
  it("expands a department with subdepartments and part-timers", () => {
    const result = expandDepartment(structure(), R);
    expect(result.people.map((item) => item.actorID)).toEqual([
      ann,
      elena,
      cyril,
      oleg,
      boris,
    ]);
    const byID = Object.fromEntries(
      result.people.map((item) => [item.actorID, item]),
    );
    expect(byID[elena]).toMatchObject({ departmentID: R, primary: false });
    // Cyril is primary in Бассейн and additional in Зал ЛФК: listed once,
    // under the primary one.
    expect(byID[cyril]).toMatchObject({ departmentID: P, primary: true });
    expect(byID[ann]!.lead).toBe(true);
    expect(byID[oleg]).toMatchObject({ departmentID: L, lead: true });
  });

  it("intersects with the chat and leaves the author out", () => {
    const result = expandDepartment(structure(), L, {
      chatMemberIDs: [oleg, cyril, xenia],
      excludeActorID: oleg,
    });
    expect(result.people.map((item) => item.actorID)).toEqual([boris, cyril]);
    expect(result.inChat.map((item) => item.actorID)).toEqual([cyril]);
    expect(result.people[0]!.inChat).toBe(false);
  });

  it("expands a position", () => {
    const result = expandPosition(structure(), INSTRUCTOR, {
      chatMemberIDs: [oleg],
    });
    expect(result.people.map((item) => item.actorID)).toEqual([oleg, cyril]);
    expect(result.inChat.map((item) => item.actorID)).toEqual([oleg]);
    expect(result.people[0]!.lead).toBe(true);
  });
});

describe("people grouped by department", () => {
  const people = [
    actor(ann, "Анна Петрова"),
    actor(oleg, "Олег Чернов"),
    actor(boris, "Борис Ёлкин"),
    actor(cyril, "Кирилл Аксёнов"),
    actor(elena, "Елена Смирнова"),
    actor(nina, "Нина Врачева"),
    actor(xenia, "Ксения Новая"),
    actor(bot, "Бот", { type: "agent" }),
  ];

  it("puts the lead first, marks part-timers, ends with «Без отдела»", () => {
    const groups = groupPeopleByDepartment(people, structure());
    expect(
      groups.map((group) =>
        group.kind === "department" ? group.department.name : "none",
      ),
    ).toEqual(["Администрация", "Реабилитация", "Бассейн", "Зал ЛФК", "none"]);
    const lfk = groups[3]!;
    expect(lfk.kind === "department" && lfk.path).toBe("Реабилитация");
    expect(
      lfk.entries.map((entry) => [
        entry.person.display_name,
        entry.lead,
        entry.additional,
      ]),
    ).toEqual([
      ["Олег Чернов", true, false],
      ["Борис Ёлкин", false, false],
      ["Кирилл Аксёнов", false, true],
    ]);
    expect(groups[1]!.entries.map((entry) => entry.additional)).toEqual([
      false,
      true,
    ]);
    // The agent is not grouped; people without a department come last.
    expect(groups[4]!.entries.map((entry) => entry.person.actor_id)).toEqual([
      xenia,
      nina,
    ]);
  });

  it("filters by department", () => {
    const value = structure();
    expect(
      groupPeopleByDepartment(people, value, { departmentID: R }).map(
        (group) => group.kind === "department" && group.department.id,
      ),
    ).toEqual([R, P, L]);
    expect(
      groupPeopleByDepartment(people, value, {
        departmentID: R,
        nested: false,
      }),
    ).toHaveLength(1);
    const none = groupPeopleByDepartment(people, value, { departmentID: null });
    expect(none.map((group) => group.kind)).toEqual(["none"]);
  });

  it("skips empty departments", () => {
    const groups = groupPeopleByDepartment(
      [actor(boris, "Борис")],
      structure(),
    );
    expect(groups).toHaveLength(1);
  });
});

describe("the line under a name", () => {
  it("prefers the position, then the caption, then the handle", () => {
    const value = structure();
    expect(personOrgLine(actor(oleg, "Олег", { title: "КМС" }), value)).toBe(
      "Инструктор",
    );
    expect(
      personOrgLine(actor(boris, "Борис", { title: " КМС " }), value),
    ).toBe("КМС");
    expect(personOrgLine(actor(boris, "Борис"), value)).toBe("@борис");
    // Without the structure loaded the caption still shows.
    expect(personOrgLine(actor(oleg, "Олег", { title: "КМС" }))).toBe("КМС");
    // The position id from ActorSummary when the person is not in people yet.
    expect(
      personOrgLine(actor(xenia, "Ксения", { position_id: DOCTOR }), value),
    ).toBe("Врач");
  });
});

describe("search", () => {
  it("finds departments and positions, «ё» as «е»", () => {
    const value = structure((item) => {
      item.departments.push(department(person(9), "Приёмная", A, null));
    });
    expect(searchOrg(value, "прием").departments).toEqual([
      {
        department: expect.objectContaining({ name: "Приёмная" }),
        path: "Администрация",
      },
    ]);
    expect(searchOrg(value, "зал").departments[0]!.path).toBe("Реабилитация");
    expect(searchOrg(value, "вра").positions.map((item) => item.name)).toEqual([
      "Врач",
    ]);
    expect(searchOrg(value, "  ")).toEqual({ departments: [], positions: [] });
  });
});

describe("editing helpers", () => {
  it("offers parents outside the subtree and within depth", () => {
    const value = structure();
    expect(departmentParentOptions(value, R).map((item) => item.id)).toEqual([
      A,
    ]);
    expect(departmentParentOptions(value, L).map((item) => item.id)).toEqual([
      A,
      R,
      P,
    ]);
    // A chain of 8 levels: nothing may go under the deepest one.
    const deep = structure((item) => {
      let parent = A;
      for (let level = 1; level < 8; level += 1) {
        const id = `40000000-0000-4000-8000-00000000000${level}`;
        item.departments.push(department(id, `Уровень ${level}`, parent, null));
        parent = id;
      }
    });
    const options = departmentParentOptions(deep, P).map((item) => item.name);
    expect(options).toContain("Уровень 6");
    expect(options).not.toContain("Уровень 7");
  });

  it("defaults deletion to the parent", () => {
    expect(departmentDeletionTargets(structure(), L).defaultTarget).toBe(R);
    expect(departmentDeletionTargets(structure(), A).defaultTarget).toBe(
      "none",
    );
    expect(
      departmentDeletionTargets(structure(), L).options.map((item) => item.id),
    ).not.toContain(L);
  });

  it("moves among siblings", () => {
    expect(departmentMoves(structure(), P)).toEqual({ up: false, down: true });
    expect(departmentMoves(structure(), L)).toEqual({ up: true, down: false });
  });

  it("shows the chat row by membership and rights", () => {
    const member = user("member", [], boris);
    expect(
      departmentChatState(
        member,
        department(L, "Зал ЛФК", R, oleg, { chat_id: "c", has_chat: true }),
      ),
    ).toEqual({ kind: "open", chatID: "c", archived: false });
    expect(
      departmentChatState(
        member,
        department(L, "Зал ЛФК", R, oleg, {
          has_chat: true,
          chat_archived: true,
        }),
      ),
    ).toEqual({ kind: "notMember", archived: true });
    expect(
      departmentChatState(member, department(L, "Зал ЛФК", R, oleg)),
    ).toEqual({
      kind: "none",
    });
    expect(
      departmentChatState(
        user("member", [], oleg),
        department(L, "Зал ЛФК", R, oleg),
      ),
    ).toEqual({ kind: "create" });
    expect(
      departmentChatState(
        user("member", ["org.manage"], boris),
        department(L, "Зал ЛФК", R, oleg),
      ),
    ).toEqual({ kind: "create" });
  });
});

describe("rights and features", () => {
  it("manages the org with org.manage or members.manage", () => {
    expect(canManageOrg(user("member"))).toBe(false);
    expect(canManageOrg(user("member", ["org.manage"]))).toBe(true);
    expect(canManageOrg(user("admin", ["members.manage"]))).toBe(true);
    expect(canManageOrg(user("owner"))).toBe(true);
  });

  it("addresses groups only with the permission, the owner always", () => {
    expect(
      canAddressGroups(user("admin", ["members.manage", "org.manage"])),
    ).toBe(false);
    expect(canAddressGroups(user("member", ["requests.address_groups"]))).toBe(
      true,
    );
    expect(canAddressGroups(user("owner"))).toBe(true);
  });

  it("shows «Оргструктура» with a department or to who may create one", () => {
    const features = ["org_structure"];
    expect(orgStructureAvailable(features)).toBe(true);
    expect(orgStructureAvailable([])).toBe(false);
    expect(showsOrgEntry(structure(), user("member"), features)).toBe(true);
    expect(showsOrgEntry(structure(), user("member"), [])).toBe(false);
    const empty = structure((value) => {
      value.departments = [];
    });
    expect(showsOrgEntry(empty, user("member"), features)).toBe(false);
    expect(showsOrgEntry(empty, user("member", ["org.manage"]), features)).toBe(
      true,
    );
    expect(showsOrgEntry(null, user("owner"), features)).toBe(true);
  });
});

describe("cache and realtime", () => {
  it("keeps the cached structure on 304", async () => {
    const cached = structure();
    const api = { orgStructure: vi.fn().mockResolvedValue(null) };
    await expect(fetchOrgStructure(api, cached)).resolves.toBe(cached);
    expect(api.orgStructure).toHaveBeenCalledWith(7);
    const fresh = structure((value) => {
      value.version = 8;
    });
    api.orgStructure.mockResolvedValue(fresh);
    await expect(fetchOrgStructure(api, cached)).resolves.toBe(fresh);
    api.orgStructure.mockResolvedValue(fresh);
    await expect(fetchOrgStructure(api, null)).resolves.toBe(fresh);
    expect(api.orgStructure).toHaveBeenLastCalledWith(undefined);
    expect(orgKeys.all).toEqual(["org"]);
  });

  it("refetches on a newer org.updated only", () => {
    const event = (version: number) => ({
      type: "org.updated",
      data: { version, reason: "membership" },
    });
    expect(orgEventEffect(event(8), 7)).toEqual({
      kind: "refetch",
      version: 8,
      delayMs: 500,
    });
    expect(orgEventEffect(event(7), 7)).toEqual({ kind: "skip" });
    expect(orgEventEffect(event(3), null)).toMatchObject({ kind: "refetch" });
    expect(orgEventEffect({ type: "message.created", data: {} }, 7)).toBeNull();
    expect(
      orgEventEffect({ type: "org.updated", data: { version: "8" } }, 7),
    ).toBeNull();
  });

  it("gathers a burst into one read and applies a write's version", async () => {
    const timers: (() => void)[] = [];
    const initial = structure();
    const next = structure((value) => {
      value.version = 9;
    });
    const api = { orgStructure: vi.fn().mockResolvedValue(next) };
    const sync = createOrgSync(api, {
      initial,
      setTimer: (run) => timers.push(run),
      clearTimer: () => {},
    });
    const seen: number[] = [];
    sync.subscribe((value) => seen.push(value.version));
    const updated = (version: number) => ({
      type: "org.updated",
      data: { version, reason: "department" },
    });
    expect(sync.handleEvent(updated(7))).toBe(false);
    expect(sync.handleEvent(updated(8))).toBe(true);
    expect(sync.handleEvent(updated(9))).toBe(true);
    expect(timers).toHaveLength(1);
    timers.shift()!();
    await vi.waitFor(() => expect(sync.current()?.version).toBe(9));
    expect(api.orgStructure).toHaveBeenCalledTimes(1);
    expect(api.orgStructure).toHaveBeenCalledWith(7);
    expect(seen).toEqual([9]);

    // A write's own response version: nothing to do when already cached.
    sync.noteVersion(9);
    expect(timers).toHaveLength(0);
    sync.noteVersion(10);
    expect(timers).toHaveLength(1);

    // A 304 keeps the same object and does not notify.
    api.orgStructure.mockResolvedValue(null);
    await sync.refresh();
    expect(seen).toEqual([9]);
    sync.dispose();
  });

  it("retries a lagging answer a couple of times", async () => {
    const timers: (() => void)[] = [];
    const api = { orgStructure: vi.fn().mockResolvedValue(structure()) };
    const sync = createOrgSync(api, {
      setTimer: (run) => timers.push(run),
      clearTimer: () => {},
    });
    sync.handleEvent({
      type: "org.updated",
      data: { version: 9, reason: "position" },
    });
    for (let round = 0; round < 3; round += 1) {
      expect(timers).toHaveLength(1);
      timers.shift()!();
      await vi.waitFor(() =>
        expect(api.orgStructure).toHaveBeenCalledTimes(round + 1),
      );
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(timers).toHaveLength(0);
    expect(sync.current()?.version).toBe(7);
  });
});
