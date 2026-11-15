import type { Page } from "@playwright/test";

/**
 * A stateful mock of the org structure server (phase 6.5 wave 2) for the
 * web e2e: GET /org with ETag/304, every write with org_version + 1 and an
 * org.updated frame, department chats, title suggestions, @department in
 * messages. Deterministic, so screenshots are stable in both themes.
 */

export const orgID = "00000000-0000-4000-8000-000000000010";
const id = (prefix: string, n: number) =>
  `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const person = (n: number) => id("20000000", n);
export const dept = (n: number) => id("10000000", n);
export const pos = (n: number) => id("30000000", n);
export const chatID = id("40000000", 1);
export const deptChatID = id("40000000", 2);

export const people = {
  anna: person(1), // owner, leads Реабилитация, doctor
  oleg: person(2), // leads Зал ЛФК, instructor
  boris: person(3), // Зал ЛФК
  cyril: person(4), // Бассейн, also in Зал ЛФК
  elena: person(5), // leads Администрация
  nina: person(6), // no department, caption «Врач»
  xenia: person(7), // no department, caption «Массажист»
  bot: person(8), // an agent
};
export const departments = {
  rehab: dept(1),
  gym: dept(2),
  pool: dept(3),
  admin: dept(4),
};
export const positions = { doctor: pos(1), instructor: pos(2), manager: pos(3) };

type Actor = {
  actor_id: string;
  display_name: string;
  handle: string;
  title: string;
  about: string;
  type: "user" | "agent";
  status_emoji: string;
  status_text: string;
  status_expires_at: null;
  avatar_version: number;
};

const actor = (
  actorID: string,
  display_name: string,
  handle: string,
  title = "",
  type: "user" | "agent" = "user",
): Actor => ({
  actor_id: actorID,
  display_name,
  handle,
  title,
  about: "",
  type,
  status_emoji: "",
  status_text: "",
  status_expires_at: null,
  avatar_version: 0,
});

export const actors: Actor[] = [
  actor(people.anna, "Анна Петрова", "anna", "Главный врач"),
  actor(people.oleg, "Олег Смирнов", "oleg", "Старший инструктор, КМС"),
  actor(people.boris, "Борис Кузнецов", "boris", "Инструктор"),
  actor(people.cyril, "Кирилл Орлов", "cyril", "Тренер по плаванию"),
  actor(people.elena, "Елена Волкова", "elena", "Офис-менеджер"),
  actor(people.nina, "Нина Соколова", "nina", "Врач"),
  actor(people.xenia, "Ксения Морозова", "xenia", "Массажист"),
  actor(people.bot, "Ассистент", "assistant", "", "agent"),
];

type Department = {
  id: string;
  parent_id: string | null;
  name: string;
  lead_actor_id: string | null;
  chat_id: string | null;
  has_chat: boolean;
  chat_archived: boolean;
  sort_key: number | null;
  version: number;
};
type Position = { id: string; name: string; sort_key: number | null; version: number };
type Membership = { actor: string; department: string; primary: boolean; at: number };

export type OrgState = {
  version: number;
  departments: Department[];
  positions: Position[];
  memberships: Membership[];
  personPosition: Record<string, string | null>;
  /** Department chat members (the viewer is a member of linked chats). */
  chatMembers: Record<string, string[]>;
};

const department = (
  departmentID: string,
  name: string,
  parent: string | null,
  lead: string | null,
): Department => ({
  id: departmentID,
  parent_id: parent,
  name,
  lead_actor_id: lead,
  chat_id: null,
  has_chat: false,
  chat_archived: false,
  sort_key: null,
  version: 1,
});

export function initialOrg(options: { empty?: boolean } = {}): OrgState {
  if (options.empty)
    return {
      version: 1,
      departments: [],
      positions: [],
      memberships: [],
      personPosition: {},
      chatMembers: {},
    };
  let at = 0;
  const member = (actorID: string, departmentID: string, primary = true) => ({
    actor: actorID,
    department: departmentID,
    primary,
    at: (at += 1),
  });
  return {
    version: 7,
    departments: [
      department(departments.rehab, "Реабилитация", null, people.anna),
      department(departments.gym, "Зал ЛФК", departments.rehab, people.oleg),
      department(departments.pool, "Бассейн", departments.rehab, people.cyril),
      department(departments.admin, "Администрация", null, people.elena),
    ],
    positions: [
      { id: positions.doctor, name: "Врач", sort_key: null, version: 1 },
      { id: positions.instructor, name: "Инструктор ЛФК", sort_key: null, version: 1 },
      { id: positions.manager, name: "Администратор", sort_key: null, version: 1 },
    ],
    memberships: [
      member(people.anna, departments.rehab),
      member(people.oleg, departments.gym),
      member(people.boris, departments.gym),
      member(people.cyril, departments.pool),
      member(people.cyril, departments.gym, false),
      member(people.elena, departments.admin),
      member(people.elena, departments.rehab, false),
    ],
    personPosition: {
      [people.anna]: positions.doctor,
      [people.oleg]: positions.instructor,
      [people.boris]: positions.instructor,
      [people.elena]: positions.manager,
    },
    chatMembers: {},
  };
}

export function orgStructure(state: OrgState, viewer: string) {
  const humans = actors.filter((item) => item.type === "user");
  return {
    version: state.version,
    departments: state.departments.map((item) => ({
      ...item,
      chat_id:
        item.chat_id && (state.chatMembers[item.chat_id] ?? []).includes(viewer)
          ? item.chat_id
          : null,
      has_chat: Boolean(item.chat_id),
    })),
    positions: state.positions,
    people: humans
      .map((item) => {
        const own = state.memberships
          .filter((membership) => membership.actor === item.actor_id)
          .sort((left, right) => left.at - right.at);
        return {
          actor_id: item.actor_id,
          primary_department_id:
            own.find((membership) => membership.primary)?.department ?? null,
          additional_department_ids: own
            .filter((membership) => !membership.primary)
            .map((membership) => membership.department),
          position_id: state.personPosition[item.actor_id] ?? null,
        };
      })
      .filter(
        (item) =>
          item.primary_department_id ||
          item.additional_department_ids.length ||
          item.position_id,
      ),
  };
}

function subtree(state: OrgState, root: string): string[] {
  const result = [root];
  for (let at = 0; at < result.length; at += 1)
    for (const child of state.departments)
      if (child.parent_id === result[at]) result.push(child.id);
  return result;
}

function expand(state: OrgState, departmentID: string): string[] {
  const ids = new Set(subtree(state, departmentID));
  return [
    ...new Set(
      state.memberships
        .filter((membership) => ids.has(membership.department))
        .map((membership) => membership.actor),
    ),
  ];
}

let stamp = 1000;
function setPrimary(state: OrgState, actorID: string, departmentID: string, keep: boolean) {
  const previous = state.memberships.find(
    (membership) => membership.actor === actorID && membership.primary,
  );
  if (previous?.department === departmentID) return;
  if (previous) {
    if (keep) previous.primary = false;
    else state.memberships.splice(state.memberships.indexOf(previous), 1);
  }
  const existing = state.memberships.find(
    (membership) =>
      membership.actor === actorID && membership.department === departmentID,
  );
  if (existing) existing.primary = true;
  else
    state.memberships.push({
      actor: actorID,
      department: departmentID,
      primary: true,
      at: (stamp += 1),
    });
}

function addAdditional(state: OrgState, actorID: string, departmentID: string) {
  if (
    state.memberships.some(
      (membership) =>
        membership.actor === actorID && membership.department === departmentID,
    )
  )
    return;
  const hasPrimary = state.memberships.some(
    (membership) => membership.actor === actorID && membership.primary,
  );
  state.memberships.push({
    actor: actorID,
    department: departmentID,
    primary: !hasPrimary,
    at: (stamp += 1),
  });
}

function removeMember(state: OrgState, actorID: string, departmentID: string) {
  const at = state.memberships.findIndex(
    (membership) =>
      membership.actor === actorID && membership.department === departmentID,
  );
  if (at < 0) return;
  const [removed] = state.memberships.splice(at, 1);
  if (removed!.primary) {
    const next = state.memberships
      .filter((membership) => membership.actor === actorID)
      .sort((left, right) => left.at - right.at)[0];
    if (next) next.primary = true;
  }
  for (const item of state.departments)
    if (item.id === departmentID && item.lead_actor_id === actorID)
      item.lead_actor_id = null;
}

export type OrgMockOptions = {
  theme?: "light" | "dark";
  viewer?: string;
  role?: "owner" | "admin" | "member";
  permissions?: string[];
  org?: OrgState;
  /** Members of the chat «Планёрка» for @department. */
  chatMembers?: string[];
  path?: string;
};

export type OrgMock = {
  state: OrgState;
  writes: Array<{ method: string; path: string; body: unknown }>;
  sent: Array<Record<string, unknown>>;
  emit(frame: Record<string, unknown>): Promise<void>;
};

const now = new Date("2026-11-11T10:15:00+03:00");

export async function mockOrg(page: Page, options: OrgMockOptions = {}): Promise<OrgMock> {
  const theme = options.theme ?? "light";
  const viewerID = options.viewer ?? people.anna;
  const viewerActor = actors.find((item) => item.actor_id === viewerID)!;
  const user = {
    id: viewerID,
    org_id: orgID,
    organization_name: "Реабцентр «Опора»",
    role: options.role ?? "owner",
    permissions: options.permissions ?? [],
    email: `${viewerActor.handle}@example.com`,
    display_name: viewerActor.display_name,
    handle: viewerActor.handle,
    title: viewerActor.title,
    about: "",
    timezone: "Europe/Moscow",
    status: "active",
    must_change_password: false,
    can_create_invitations: false,
    status_emoji: "",
    status_text: "",
    status_expires_at: null,
    avatar_version: 0,
    created_at: "2026-08-19T00:00:00Z",
  };
  const state = options.org ?? initialOrg();
  const chatMembers = options.chatMembers ?? [
    people.anna,
    people.oleg,
    people.boris,
    people.cyril,
    people.nina,
  ];
  const writes: OrgMock["writes"] = [];
  const sent: OrgMock["sent"] = [];
  let seq = 10;

  await page.clock.setFixedTime(now);
  await page.addInitScript((value) => {
    localStorage.setItem("coma-locale", "ru");
    localStorage.setItem("coma-theme", value);
    class FakeSocket {
      static OPEN = 1;
      static latest: FakeSocket | null = null;
      readyState = 1;
      onopen: null | (() => void) = null;
      onmessage: null | ((event: { data: string }) => void) = null;
      onclose: null | ((event: { code: number }) => void) = null;
      constructor() {
        FakeSocket.latest = this;
        setTimeout(() => this.onopen?.(), 0);
      }
      send(raw: string) {
        const frame = JSON.parse(raw);
        if (frame.op === "auth")
          setTimeout(
            () =>
              this.onmessage?.({
                data: JSON.stringify({
                  op: "hello",
                  request_id: frame.request_id,
                  connection_id: "00000000-0000-4000-8000-000000000099",
                  current_seq: 0,
                  min_retained_seq: 0,
                  heartbeat_interval_ms: 25000,
                  ack_interval_ms: 1000,
                  ack_batch_size: 50,
                  max_unacked_events: 128,
                  features: ["org_structure", "message_requests"],
                }),
              }),
            0,
          );
      }
      close() {}
    }
    Object.assign(window, {
      WebSocket: FakeSocket,
      __emitComaEvent: (frame: unknown) =>
        FakeSocket.latest?.onmessage?.({ data: JSON.stringify(frame) }),
    });
  }, theme);

  const emit = (frame: Record<string, unknown>) =>
    page
      .evaluate(
        (value) =>
          (window as unknown as { __emitComaEvent(frame: unknown): void }).__emitComaEvent(value),
        frame,
      )
      .catch(() => undefined);
  const orgUpdated = (reason: string) => {
    state.version += 1;
    seq += 1;
    void emit({
      op: "event",
      seq,
      type: "org.updated",
      occurred_at: now.toISOString(),
      actor_id: viewerID,
      chat_id: null,
      subject_id: orgID,
      data: { version: state.version, reason },
    });
  };
  const departmentOut = (departmentID: string) =>
    orgStructure(state, viewerID).departments.find((item) => item.id === departmentID);

  const chat = {
    id: chatID,
    kind: "group",
    visibility: "private",
    name: "Планёрка",
    topic: "",
    role: "owner",
    created_at: "2026-08-19T00:00:00Z",
    archived_at: null,
    display_name: "Планёрка",
    avatar_seed: "plan",
    avatar_version: 0,
    notify_level: "default",
    muted_until: null,
    last_activity_seq: 3,
    last_message_at: "2026-11-11T06:30:00Z",
    last_message: null,
  };
  const chats = () => [
    chat,
    ...state.departments
      .filter((item) => item.chat_id && (state.chatMembers[item.chat_id] ?? []).includes(viewerID))
      .map((item) => ({
        ...chat,
        id: item.chat_id!,
        name: item.name,
        display_name: item.name,
        avatar_seed: item.name,
      })),
  ];

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api\/v1/, "");
    const method = request.method();
    let input: Record<string, unknown> = {};
    try {
      input = (request.postDataJSON() as Record<string, unknown>) ?? {};
    } catch {
      input = {};
    }
    if (path.startsWith("/org") && method !== "GET") writes.push({ method, path, body: input });
    let status = 200;
    let body: unknown = {};
    const fail = (code: number, error: string) => {
      status = code;
      body = { code: error, message: error };
    };
    const match = (pattern: RegExp) => pattern.exec(path);
    let m: RegExpExecArray | null;

    if (path === "/bootstrap/status") body = { bootstrapped: true };
    else if (path === "/branding")
      body = {
        workspace_name: user.organization_name,
        accent_color: "#174586",
        version: 1,
        password_recovery_available: false,
        email_delivery_available: false,
      };
    else if (path === "/auth/refresh")
      body = {
        access_token: "test",
        access_expires_at: "2026-11-12T00:00:00Z",
        user,
      };
    else if (path === "/me") body = user;
    else if (path === "/preferences")
      body = {
        theme,
        locale: "ru",
        in_app_enabled: true,
        push_enabled: false,
        push_preview: false,
        notify_messages: "all",
        notify_threads: "all",
        notify_reactions: true,
        notify_invites: true,
        notify_system: true,
        sound_enabled: false,
        sound_id: "default",
        schedule: null,
        snoozed_until: null,
        email_digest: false,
      };
    else if (path === "/preferences/chat-folders") body = [];
    else if (path === "/preferences/pinned-chats") body = [];
    else if (path === "/chats" && method === "GET") body = { chats: chats() };
    else if (path === "/unread")
      body = {
        chats: chats().map((item) => ({
          chat_id: item.id,
          last_read_seq: 3,
          unread_count: 0,
          mention_count: 0,
        })),
        threads: [],
      };
    else if (path === "/drafts") body = { drafts: [] };
    else if (path === "/agents") body = [];
    else if (path === "/actors") body = { actors, next_after_id: null };
    else if (path === "/organization/members")
      body = {
        members: actors
          .filter((item) => item.type === "user")
          .map((item) => ({
            ...item,
            email: `${item.handle}@example.com`,
            role: item.actor_id === people.anna ? "owner" : item.actor_id === people.elena ? "admin" : "member",
            status: "active",
            permissions: item.actor_id === people.elena ? ["members.manage"] : [],
            created_at: "2026-08-19T00:00:00Z",
            last_seen_at: null,
          })),
      };
    else if ((m = match(/^\/organization\/members\/([^/]+)$/)) && method === "PATCH") {
      writes.push({ method, path, body: input });
      const item = actors.find((entry) => entry.actor_id === m![1])!;
      body = {
        ...item,
        email: `${item.handle}@example.com`,
        role: "member",
        status: "active",
        permissions: (input.permissions as string[]) ?? [],
        created_at: "2026-08-19T00:00:00Z",
        last_seen_at: null,
      };
    } else if (path === "/org" && method === "GET") {
      // Playwright cannot fulfil a 304 (a "redirect" status): the mock
      // always answers in full; 304 is covered by the core tests and the
      // live run.
      body = orgStructure(state, viewerID);
    } else if (path === "/org/departments" && method === "POST") {
      const name = String(input.name ?? "").trim();
      const parent = (input.parent_id as string | undefined) ?? null;
      if (state.departments.some((item) => item.parent_id === parent && item.name.toLowerCase() === name.toLowerCase()))
        fail(409, "org_name_taken");
      else {
        const created = department(dept(50 + state.departments.length), name, parent, null);
        state.departments.push(created);
        for (const entry of (input.members as Array<{ actor_id: string; primary: boolean }>) ?? [])
          if (entry.primary) setPrimary(state, entry.actor_id, created.id, false);
          else addAdditional(state, entry.actor_id, created.id);
        if (input.lead_actor_id) {
          addAdditional(state, String(input.lead_actor_id), created.id);
          created.lead_actor_id = String(input.lead_actor_id);
        }
        orgUpdated("department");
        status = 201;
        body = { department: departmentOut(created.id), version: state.version };
      }
    } else if ((m = match(/^\/org\/departments\/([^/]+)$/)) && method === "PATCH") {
      const item = state.departments.find((entry) => entry.id === m![1]);
      if (!item) fail(404, "department_not_found");
      else if (input.expected_version !== item.version) fail(409, "org_version_conflict");
      else {
        if (typeof input.name === "string") item.name = input.name.trim();
        if ("parent_id" in input) item.parent_id = (input.parent_id as string | null) ?? null;
        if ("lead_actor_id" in input) {
          const lead = (input.lead_actor_id as string | null) ?? null;
          if (lead) addAdditional(state, lead, item.id);
          item.lead_actor_id = lead;
        }
        item.version += 1;
        orgUpdated("department");
        body = { department: departmentOut(item.id), version: state.version };
      }
    } else if ((m = match(/^\/org\/departments\/([^/]+)\/move$/))) {
      const item = state.departments.find((entry) => entry.id === m![1])!;
      const siblings = state.departments
        .filter((entry) => entry.parent_id === item.parent_id)
        .sort((left, right) => (left.sort_key ?? 0) - (right.sort_key ?? 0) || left.name.localeCompare(right.name, "ru"));
      siblings.forEach((entry, index) => (entry.sort_key = index * 10));
      const at = siblings.indexOf(item);
      const other = siblings[input.direction === "up" ? at - 1 : at + 1];
      if (other) [item.sort_key, other.sort_key] = [other.sort_key, item.sort_key];
      orgUpdated("department");
      body = { department: departmentOut(item.id), version: state.version };
    } else if ((m = match(/^\/org\/departments\/([^/]+)$/)) && method === "DELETE") {
      const item = state.departments.find((entry) => entry.id === m![1]);
      if (!item) fail(404, "department_not_found");
      else {
        const target = url.searchParams.get("members_to") ?? item.parent_id ?? "none";
        for (const child of state.departments) if (child.parent_id === item.id) child.parent_id = item.parent_id;
        const primaries = state.memberships.filter((entry) => entry.department === item.id && entry.primary).map((entry) => entry.actor);
        state.memberships = state.memberships.filter((entry) => entry.department !== item.id);
        for (const actorID of primaries)
          if (target !== "none") setPrimary(state, actorID, target, false);
          else {
            const next = state.memberships.filter((entry) => entry.actor === actorID).sort((l, r) => l.at - r.at)[0];
            if (next) next.primary = true;
          }
        state.departments = state.departments.filter((entry) => entry.id !== item.id);
        orgUpdated("department");
        status = 204;
        body = undefined;
      }
    } else if ((m = match(/^\/org\/departments\/([^/]+)\/members\/([^/]+)$/))) {
      if (method === "PUT") {
        if (input.primary) setPrimary(state, m[2]!, m[1]!, Boolean(input.keep_previous));
        else addAdditional(state, m[2]!, m[1]!);
        orgUpdated("membership");
        body = { person: orgStructure(state, viewerID).people.find((entry) => entry.actor_id === m![2]), version: state.version };
      } else {
        removeMember(state, m[2]!, m[1]!);
        orgUpdated("membership");
        status = 204;
        body = undefined;
      }
    } else if ((m = match(/^\/org\/people\/([^/]+)$/)) && method === "PUT") {
      if (input.expected_org_version && input.expected_org_version !== state.version) fail(409, "org_version_conflict");
      else {
        const actorID = m[1]!;
        state.memberships = state.memberships.filter((entry) => entry.actor !== actorID);
        if (input.primary_department_id) setPrimary(state, actorID, String(input.primary_department_id), false);
        for (const extra of (input.additional_department_ids as string[]) ?? []) addAdditional(state, actorID, extra);
        state.personPosition[actorID] = (input.position_id as string | null) ?? null;
        orgUpdated("membership");
        body = { person: orgStructure(state, viewerID).people.find((entry) => entry.actor_id === actorID), version: state.version };
      }
    } else if (path === "/org/people/assign") {
      for (const actorID of input.actor_ids as string[]) {
        if (input.primary_department_id) setPrimary(state, actorID, String(input.primary_department_id), false);
        if (input.add_department_id) addAdditional(state, actorID, String(input.add_department_id));
        if ("position_id" in input) state.personPosition[actorID] = (input.position_id as string | null) ?? null;
      }
      orgUpdated("membership");
      body = { people: orgStructure(state, viewerID).people, version: state.version };
    } else if (path === "/org/positions" && method === "POST") {
      const created = { id: pos(50 + state.positions.length), name: String(input.name).trim(), sort_key: null, version: 1 };
      state.positions.push(created);
      orgUpdated("position");
      status = 201;
      body = { position: created, version: state.version };
    } else if (path === "/org/positions/bulk") {
      const created: Position[] = [];
      const skipped: string[] = [];
      for (const name of input.names as string[]) {
        if (state.positions.some((entry) => entry.name.toLowerCase() === name.toLowerCase())) skipped.push(name);
        else {
          const item = { id: pos(50 + state.positions.length), name, sort_key: null, version: 1 };
          state.positions.push(item);
          created.push(item);
        }
      }
      orgUpdated("position");
      status = 201;
      body = { created, skipped, version: state.version };
    } else if ((m = match(/^\/org\/positions\/([^/]+)$/))) {
      const item = state.positions.find((entry) => entry.id === m![1])!;
      if (method === "PATCH") {
        item.name = String(input.name);
        item.version += 1;
        orgUpdated("position");
        body = { position: item, version: state.version };
      } else {
        state.positions = state.positions.filter((entry) => entry.id !== item.id);
        for (const key of Object.keys(state.personPosition)) if (state.personPosition[key] === item.id) state.personPosition[key] = null;
        orgUpdated("position");
        status = 204;
        body = undefined;
      }
    } else if (path === "/org/title-suggestions") {
      const known = new Set(state.positions.map((entry) => entry.name.toLowerCase()));
      const byTitle = new Map<string, string[]>();
      for (const item of actors)
        if (item.type === "user" && item.title && !known.has(item.title.toLowerCase()))
          byTitle.set(item.title, [...(byTitle.get(item.title) ?? []), item.actor_id]);
      body = {
        suggestions: [...byTitle].map(([title, ids]) => ({ title, count: ids.length, actor_ids: ids })),
      };
    } else if ((m = match(/^\/org\/departments\/([^/]+)\/chat$/))) {
      const item = state.departments.find((entry) => entry.id === m![1])!;
      if (method === "POST") {
        item.chat_id = deptChatID;
        state.chatMembers[deptChatID] = [...new Set([viewerID, ...expand(state, item.id)])];
        orgUpdated("department");
        body = {
          chat: { ...chat, id: deptChatID, name: item.name, display_name: item.name },
          department: departmentOut(item.id),
          version: state.version,
        };
      } else if (method === "PUT") {
        item.chat_id = String(input.chat_id);
        state.chatMembers[item.chat_id] = chatMembers;
        orgUpdated("department");
        body = { department: departmentOut(item.id), version: state.version };
      } else {
        item.chat_id = null;
        orgUpdated("department");
        status = 204;
        body = undefined;
      }
    } else if ((m = match(/^\/org\/departments\/([^/]+)\/chat\/missing$/))) {
      const item = state.departments.find((entry) => entry.id === m![1])!;
      const inChat = new Set(state.chatMembers[item.chat_id ?? ""] ?? []);
      body = { actors: actors.filter((entry) => expand(state, item.id).includes(entry.actor_id) && !inChat.has(entry.actor_id)) };
    } else if ((m = match(/^\/org\/departments\/([^/]+)\/chat\/add-missing$/))) {
      const item = state.departments.find((entry) => entry.id === m![1])!;
      const list = state.chatMembers[item.chat_id!] ?? [];
      const missing = expand(state, item.id).filter((entry) => !list.includes(entry));
      state.chatMembers[item.chat_id!] = [...list, ...missing];
      body = { added: missing.length };
    } else if ((m = match(/^\/chats\/([^/]+)\/members$/))) {
      const ids = m[1] === chatID ? chatMembers : (state.chatMembers[m[1]!] ?? []);
      body = {
        members: actors
          .filter((entry) => ids.includes(entry.actor_id))
          .map((entry) => ({ ...entry, role: entry.actor_id === viewerID ? "owner" : "member", joined_at: "2026-08-19T00:00:00Z" })),
      };
    } else if ((m = match(/^\/chats\/([^/]+)\/(pins|agents)$/))) body = m[2] === "pins" ? { pins: [] } : { agents: [] };
    else if ((m = match(/^\/chats\/([^/]+)\/requests$/)) && method === "POST") {
      // The request itself is the request package's business: record what
      // the form sent and answer with a plain message.
      sent.push({ request: input });
      status = 201;
      body = {
        id: id("50000000", 90 + sent.length),
        chat_id: m[1],
        actor_id: viewerID,
        client_msg_id: input.client_msg_id,
        type: "text",
        body: input.body,
        body_format: "plain",
        version: 1,
        created_seq: 3 + sent.length,
        created_at: now.toISOString(),
        mentioned_actor_ids: [],
        files: [],
        thread_reply_count: 0,
      };
    } else if ((m = match(/^\/chats\/([^/]+)\/messages$/)) && method === "POST") {
      sent.push(input);
      const departmentIDs = (input.mentioned_department_ids as string[]) ?? [];
      const ids = m[1] === chatID ? chatMembers : [];
      const mentioned = departmentIDs.map((departmentID) => ({
        department_id: departmentID,
        notified_count: expand(state, departmentID).filter((entry) => ids.includes(entry) && entry !== viewerID).length,
      }));
      status = 201;
      body = {
        id: id("50000000", sent.length),
        chat_id: m[1],
        actor_id: viewerID,
        client_msg_id: input.client_msg_id,
        type: "text",
        body: input.body,
        body_format: "markdown",
        version: 1,
        created_seq: 3 + sent.length,
        created_at: now.toISOString(),
        mentioned_actor_ids: input.mentioned_actor_ids ?? [],
        mentioned_department_ids: departmentIDs,
        mentioned_departments: mentioned,
        files: [],
        thread_reply_count: 0,
      };
    } else if ((m = match(/^\/chats\/([^/]+)\/messages$/))) body = { messages: [], next_before_seq: null };
    else if ((m = match(/^\/chats\/([^/]+)\/read$/)))
      body = { chat_id: m[1], last_read_seq: 3, last_read_at: now.toISOString() };
    else if (path === "/scheduled-messages") body = { scheduled_messages: [] };
    else status = 404;
    await route.fulfill({
      status,
      contentType: "application/json",
      body: body === undefined ? "" : JSON.stringify(body),
    });
  });
  return { state, writes, sent, emit };
}
