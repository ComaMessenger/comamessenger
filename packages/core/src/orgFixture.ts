import type {
  ActorSummary,
  OrgDepartment,
  OrgStructure,
  Permission,
  User,
} from "./types";

/** Test data for the org structure: a small rehabilitation centre. */
export const R = "10000000-0000-4000-8000-000000000001"; // Реабилитация
export const L = "10000000-0000-4000-8000-000000000002"; // Зал ЛФК
export const P = "10000000-0000-4000-8000-000000000003"; // Бассейн
export const A = "10000000-0000-4000-8000-000000000004"; // Администрация
export const DOCTOR = "30000000-0000-4000-8000-000000000001";
export const INSTRUCTOR = "30000000-0000-4000-8000-000000000002";

export const person = (n: number) => `20000000-0000-4000-8000-00000000000${n}`;
export const ann = person(1); // leads Реабилитация, doctor
export const oleg = person(2); // leads Зал ЛФК, instructor
export const boris = person(3); // Зал ЛФК
export const cyril = person(4); // Бассейн, additional in Зал ЛФК, instructor
export const elena = person(5); // leads Администрация, additional in Реабилитация
export const nina = person(6); // no department, doctor
export const xenia = person(7); // outside the structure
export const bot = person(8); // an agent

export function department(
  id: string,
  name: string,
  parent: string | null,
  lead: string | null,
  extra: Partial<OrgDepartment> = {},
): OrgDepartment {
  return {
    id,
    parent_id: parent,
    name,
    lead_actor_id: lead,
    chat_id: null,
    has_chat: false,
    chat_archived: false,
    sort_key: null,
    version: 1,
    ...extra,
  };
}

export function structure(
  patch: (value: OrgStructure) => void = () => {},
): OrgStructure {
  const value: OrgStructure = {
    version: 7,
    departments: [
      department(L, "Зал ЛФК", R, oleg),
      department(R, "Реабилитация", null, ann),
      department(P, "Бассейн", R, null),
      department(A, "Администрация", null, elena),
    ],
    positions: [
      { id: INSTRUCTOR, name: "Инструктор", sort_key: null, version: 1 },
      { id: DOCTOR, name: "Врач", sort_key: null, version: 1 },
    ],
    people: [
      {
        actor_id: ann,
        primary_department_id: R,
        additional_department_ids: [],
        position_id: DOCTOR,
      },
      {
        actor_id: oleg,
        primary_department_id: L,
        additional_department_ids: [],
        position_id: INSTRUCTOR,
      },
      {
        actor_id: boris,
        primary_department_id: L,
        additional_department_ids: [],
        position_id: null,
      },
      {
        actor_id: cyril,
        primary_department_id: P,
        additional_department_ids: [L],
        position_id: INSTRUCTOR,
      },
      {
        actor_id: elena,
        primary_department_id: A,
        additional_department_ids: [R],
        position_id: null,
      },
      {
        actor_id: nina,
        primary_department_id: null,
        additional_department_ids: [],
        position_id: DOCTOR,
      },
    ],
  };
  patch(value);
  return value;
}

export function actor(
  id: string,
  name: string,
  extra: Partial<ActorSummary> = {},
): ActorSummary {
  return {
    actor_id: id,
    display_name: name,
    handle: name.toLowerCase().split(" ")[0]!,
    title: "",
    about: "",
    type: "user",
    status_emoji: "",
    status_text: "",
    status_expires_at: null,
    avatar_version: 0,
    ...extra,
  };
}

export function user(
  role: User["role"],
  permissions: Permission[] = [],
  id = ann,
): User {
  return {
    id,
    org_id: "00000000-0000-4000-8000-000000000002",
    organization_name: "Опора",
    role,
    email: "user@example.test",
    display_name: "User",
    handle: "user",
    title: "",
    about: "",
    timezone: "UTC",
    status: "active",
    permissions,
    must_change_password: false,
    can_create_invitations: false,
    status_emoji: "",
    status_text: "",
    status_expires_at: null,
    avatar_version: 0,
    created_at: "2026-08-21T00:00:00Z",
  };
}
