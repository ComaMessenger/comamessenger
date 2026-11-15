import type { MessengerAPI } from "./api";
import { hasServerFeature, serverFeature } from "./realtime";
import { hasPermission } from "./settings";
import type {
  ActorSummary,
  DurableEvent,
  OrgDepartment,
  OrgPerson,
  OrgPosition,
  OrgStructure,
  OrgUpdatedEvent,
  User,
} from "./types";

/**
 * The org structure (phase 6.5 wave 2): departments with nesting, leads,
 * primary and additional memberships, positions. Shared by the phone and the
 * web: the cache by version, the tree and its order, paths, counts,
 * expanding a department for a preview, «Руководитель» and «Подчинённые»,
 * grouping «Люди» by department and the line under a person's name.
 *
 * Everything works on one `OrgStructure` (GET /api/v1/org). It lists active
 * people only, so a deactivated person drops out of every count here, and a
 * lead who is not active comes as `lead_actor_id: null`.
 */

/** The deepest nesting the server accepts (`422 org_depth_exceeded`). */
export const orgMaxDepth = 8;
/** How long a burst of org.updated is gathered before reading GET /org. */
export const orgRefetchDelayMs = 500;
/** Separator of department paths: «Реабилитация › Зал ЛФК». */
export const orgPathSeparator = " › ";

export const orgKeys = {
  all: ["org"] as const,
};

/** The server announced org_structure: show everything of wave 2. */
export function orgStructureAvailable(
  features: Iterable<string> | null | undefined,
): boolean {
  return hasServerFeature(features, serverFeature.orgStructure);
}

/** «Оргструктура» settings and every write: org.manage or members.manage. */
export function canManageOrg(user: User): boolean {
  return (
    hasPermission(user, "org.manage") || hasPermission(user, "members.manage")
  );
}

/** Requests to a department or a position; the owner always may. */
export function canAddressGroups(user: User): boolean {
  return hasPermission(user, "requests.address_groups");
}

/**
 * The «Оргструктура» row of «Ещё» / «Люди»: shown when there is at least one
 * department, or to whoever may create the first one.
 */
export function showsOrgEntry(
  structure: OrgStructure | null | undefined,
  user: User,
  features: Iterable<string> | null | undefined,
): boolean {
  if (!orgStructureAvailable(features)) return false;
  return Boolean(structure?.departments.length) || canManageOrg(user);
}

// ---------------------------------------------------------------------------
// Search folding

/** Lower case, «ё» as «е», trimmed: how org names are compared to a query. */
export function foldOrgText(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/ё/g, "е");
}

function queryWords(query: string): string[] {
  return foldOrgText(query).replace(/^@+/, "").split(/\s+/).filter(Boolean);
}

/** Every word of the query is found in the name. */
export function orgNameMatches(name: string, query: string): boolean {
  const words = queryWords(query);
  if (!words.length) return true;
  const haystack = foldOrgText(name);
  return words.every((word) => haystack.includes(word));
}

// ---------------------------------------------------------------------------
// Index

export type OrgMembership = {
  actorID: string;
  departmentID: string;
  primary: boolean;
};

export type OrgIndex = {
  structure: OrgStructure;
  departments: ReadonlyMap<string, OrgDepartment>;
  positions: ReadonlyMap<string, OrgPosition>;
  people: ReadonlyMap<string, OrgPerson>;
  /** Children in display order; `null` holds the top level. */
  children: ReadonlyMap<string | null, readonly OrgDepartment[]>;
  /** Direct members of each department: primary first, then additional. */
  members: ReadonlyMap<string, readonly OrgMembership[]>;
  /** Every department in tree order (depth first). */
  order: readonly OrgDepartment[];
  /** Depth of each department, 0 for the top level. */
  depth: ReadonlyMap<string, number>;
  /** Positions in display order. */
  positionOrder: readonly OrgPosition[];
};

const collator = new Intl.Collator("ru", {
  sensitivity: "base",
  numeric: true,
});

/** Manual order first (sort_key), then by name, as the server lists siblings. */
export function compareOrgItems(
  left: { sort_key: number | null; name: string; id: string },
  right: { sort_key: number | null; name: string; id: string },
): number {
  if (left.sort_key !== null || right.sort_key !== null) {
    if (left.sort_key === null) return 1;
    if (right.sort_key === null) return -1;
    if (left.sort_key !== right.sort_key) return left.sort_key - right.sort_key;
  }
  return (
    collator.compare(left.name, right.name) ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  );
}

const indexes = new WeakMap<OrgStructure, OrgIndex>();

/**
 * Lookups over one structure, built once per structure object. A department
 * whose parent is missing is shown at the top level; a cycle (which the
 * server refuses) cannot hang the client.
 */
export function orgIndex(structure: OrgStructure): OrgIndex {
  const cached = indexes.get(structure);
  if (cached) return cached;
  const departments = new Map(
    structure.departments.map((department) => [department.id, department]),
  );
  const positions = new Map(
    structure.positions.map((position) => [position.id, position]),
  );
  const people = new Map(
    structure.people.map((person) => [person.actor_id, person]),
  );
  const children = new Map<string | null, OrgDepartment[]>();
  for (const department of structure.departments) {
    const parent =
      department.parent_id && departments.has(department.parent_id)
        ? department.parent_id
        : null;
    const list = children.get(parent) ?? [];
    list.push(department);
    children.set(parent, list);
  }
  for (const list of children.values()) list.sort(compareOrgItems);

  const members = new Map<string, OrgMembership[]>();
  const add = (membership: OrgMembership) => {
    if (!departments.has(membership.departmentID)) return;
    const list = members.get(membership.departmentID) ?? [];
    list.push(membership);
    members.set(membership.departmentID, list);
  };
  for (const person of structure.people)
    if (person.primary_department_id)
      add({
        actorID: person.actor_id,
        departmentID: person.primary_department_id,
        primary: true,
      });
  for (const person of structure.people)
    for (const departmentID of person.additional_department_ids)
      if (departmentID !== person.primary_department_id)
        add({ actorID: person.actor_id, departmentID, primary: false });

  const order: OrgDepartment[] = [];
  const depth = new Map<string, number>();
  const visit = (parent: string | null, level: number) => {
    for (const department of children.get(parent) ?? []) {
      if (depth.has(department.id)) continue;
      depth.set(department.id, level);
      order.push(department);
      visit(department.id, level + 1);
    }
  };
  visit(null, 0);
  // Departments caught in a cycle never hang off the top level: show them
  // there instead of losing them.
  for (const department of structure.departments)
    if (!depth.has(department.id)) {
      depth.set(department.id, 0);
      order.push(department);
      const list = children.get(null) ?? [];
      list.push(department);
      children.set(null, list);
      visit(department.id, 1);
    }

  const index: OrgIndex = {
    structure,
    departments,
    positions,
    people,
    children,
    members,
    order,
    depth,
    positionOrder: [...structure.positions].sort(compareOrgItems),
  };
  indexes.set(structure, index);
  return index;
}

// ---------------------------------------------------------------------------
// Tree, paths, counts

export type OrgTreeNode = {
  department: OrgDepartment;
  depth: number;
  children: OrgTreeNode[];
  /** Active people of the department and its subdepartments, no repeats. */
  count: number;
  /** Active people of the department itself, primary and additional. */
  directCount: number;
};

/** The tree for «Оргструктура»: siblings by sort_key, then by name. */
export function buildOrgTree(structure: OrgStructure): OrgTreeNode[] {
  const index = orgIndex(structure);
  const seen = new Set<string>();
  const build = (department: OrgDepartment): OrgTreeNode => {
    seen.add(department.id);
    return {
      department,
      depth: index.depth.get(department.id) ?? 0,
      children: (index.children.get(department.id) ?? [])
        .filter((child) => !seen.has(child.id))
        .map(build),
      count: departmentCount(structure, department.id),
      directCount: departmentCount(structure, department.id, {
        nested: false,
      }),
    };
  };
  return (index.children.get(null) ?? [])
    .filter((department) => !seen.has(department.id))
    .map(build);
}

export type OrgTreeRow = {
  node: OrgTreeNode;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
};

/**
 * The visible rows of a tree with some departments expanded, for a flat
 * list (FlatList, a virtualised list, keyboard navigation).
 */
export function flattenOrgTree(
  tree: readonly OrgTreeNode[],
  expanded: ReadonlySet<string> | "all",
): OrgTreeRow[] {
  const rows: OrgTreeRow[] = [];
  const walk = (nodes: readonly OrgTreeNode[]) => {
    for (const node of nodes) {
      const open = expanded === "all" || expanded.has(node.department.id);
      rows.push({
        node,
        depth: node.depth,
        hasChildren: node.children.length > 0,
        expanded: open && node.children.length > 0,
      });
      if (open) walk(node.children);
    }
  };
  walk(tree);
  return rows;
}

/** Parents of a department from the top level down, the department left out. */
export function departmentAncestors(
  structure: OrgStructure,
  departmentID: string,
): OrgDepartment[] {
  const index = orgIndex(structure);
  const result: OrgDepartment[] = [];
  const seen = new Set([departmentID]);
  let parentID = index.departments.get(departmentID)?.parent_id ?? null;
  while (parentID && !seen.has(parentID)) {
    const parent = index.departments.get(parentID);
    if (!parent) break;
    seen.add(parentID);
    result.unshift(parent);
    parentID = parent.parent_id;
  }
  return result;
}

/**
 * «Реабилитация › Зал ЛФК». Without the department itself
 * (`includeSelf: false`) a top-level department gives an empty string: the
 * client writes «верхний уровень».
 */
export function departmentPath(
  structure: OrgStructure,
  departmentID: string,
  options: { includeSelf?: boolean } = {},
): string {
  const names = departmentAncestors(structure, departmentID).map(
    (department) => department.name,
  );
  const self = orgIndex(structure).departments.get(departmentID);
  if ((options.includeSelf ?? true) && self) names.push(self.name);
  return names.join(orgPathSeparator);
}

/** The department and all its subdepartments, in tree order. */
export function departmentSubtree(
  structure: OrgStructure,
  departmentID: string,
): string[] {
  const index = orgIndex(structure);
  if (!index.departments.has(departmentID)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  const walk = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    result.push(id);
    for (const child of index.children.get(id) ?? []) walk(child.id);
  };
  walk(departmentID);
  return result;
}

/**
 * Active people of a department: the lead first, then primary and additional
 * members, then (with `nested`, the default) those of the subdepartments in
 * tree order. Nobody is listed twice.
 */
export function departmentPeople(
  structure: OrgStructure,
  departmentID: string,
  options: { nested?: boolean } = {},
): string[] {
  const index = orgIndex(structure);
  const ids =
    options.nested === false
      ? [departmentID]
      : departmentSubtree(structure, departmentID);
  const result = new Set<string>();
  for (const id of ids) {
    const lead = index.departments.get(id)?.lead_actor_id;
    if (lead && index.people.has(lead)) result.add(lead);
    for (const membership of index.members.get(id) ?? [])
      result.add(membership.actorID);
  }
  return [...result];
}

/** How many active people a department has, with subdepartments by default. */
export function departmentCount(
  structure: OrgStructure,
  departmentID: string,
  options: { nested?: boolean } = {},
): number {
  return departmentPeople(structure, departmentID, options).length;
}

/** Active people with the position. */
export function positionPeople(
  structure: OrgStructure,
  positionID: string,
): string[] {
  return structure.people
    .filter((person) => person.position_id === positionID)
    .map((person) => person.actor_id);
}

export type OrgExpandedPerson = {
  actorID: string;
  /** The department of the subtree the person is listed under. */
  departmentID: string;
  /** False for «совм.»: only an additional member there. */
  primary: boolean;
  /** Leads the department they are listed under. */
  lead: boolean;
  /** Is a member of the chat (always true without `chatMemberIDs`). */
  inChat: boolean;
};

export type OrgExpansion = {
  /** Everyone, as the server expands it without a chat, author left out. */
  people: OrgExpandedPerson[];
  /** Those of them in the chat (all of them without `chatMemberIDs`). */
  inChat: OrgExpandedPerson[];
};

type ExpandOptions = {
  /** Active members of the chat; people only, agents are never expanded. */
  chatMemberIDs?: Iterable<string>;
  /** The author: left out, as the server does. */
  excludeActorID?: string;
};

function finishExpansion(
  people: OrgExpandedPerson[],
  options: ExpandOptions,
): OrgExpansion {
  const chat = options.chatMemberIDs ? new Set(options.chatMemberIDs) : null;
  const listed = people
    .filter((person) => person.actorID !== options.excludeActorID)
    .map((person) => ({
      ...person,
      inChat: chat ? chat.has(person.actorID) : true,
    }));
  return { people: listed, inChat: listed.filter((person) => person.inChat) };
}

/**
 * Who a department stands for, the way the server expands @отдел and a
 * request to a department: the department and its subdepartments, primary
 * and additional members, without repeats. A person in several departments
 * of the subtree is listed under their primary one if it is there, else
 * under the first in tree order. With `chatMemberIDs`, `inChat` tells who
 * would be notified.
 */
export function expandDepartment(
  structure: OrgStructure,
  departmentID: string,
  options: ExpandOptions = {},
): OrgExpansion {
  const index = orgIndex(structure);
  const byActor = new Map<string, OrgExpandedPerson>();
  for (const id of departmentSubtree(structure, departmentID)) {
    const lead = index.departments.get(id)?.lead_actor_id ?? null;
    const memberships = index.members.get(id) ?? [];
    for (const membership of memberships) {
      const known = byActor.get(membership.actorID);
      if (known && (known.primary || !membership.primary)) continue;
      byActor.set(membership.actorID, {
        actorID: membership.actorID,
        departmentID: id,
        primary: membership.primary,
        lead: lead === membership.actorID,
        inChat: true,
      });
    }
  }
  // The lead of the department itself first, then tree order.
  const ordered = departmentPeople(structure, departmentID)
    .map((actorID) => byActor.get(actorID))
    .filter((person): person is OrgExpandedPerson => Boolean(person));
  return finishExpansion(ordered, options);
}

/** Who a position stands for, as the server expands a request to it. */
export function expandPosition(
  structure: OrgStructure,
  positionID: string,
  options: ExpandOptions = {},
): OrgExpansion {
  const index = orgIndex(structure);
  const people = positionPeople(structure, positionID).map((actorID) => {
    const person = index.people.get(actorID)!;
    const departmentID = person.primary_department_id ?? "";
    return {
      actorID,
      departmentID,
      primary: Boolean(person.primary_department_id),
      lead:
        Boolean(departmentID) &&
        index.departments.get(departmentID)?.lead_actor_id === actorID,
      inChat: true,
    };
  });
  return finishExpansion(people, options);
}

// ---------------------------------------------------------------------------
// One person

export type PersonOrg = {
  primary: OrgDepartment | null;
  /** «совм.»: oldest membership first. */
  additional: OrgDepartment[];
  position: OrgPosition | null;
  /** Departments the person leads, in tree order. */
  leads: OrgDepartment[];
};

/** Where a person is. Empty for someone outside the structure. */
export function personOrg(structure: OrgStructure, actorID: string): PersonOrg {
  const index = orgIndex(structure);
  const person = index.people.get(actorID);
  const department = (id: string | null | undefined) =>
    (id && index.departments.get(id)) || null;
  return {
    primary: department(person?.primary_department_id),
    additional: (person?.additional_department_ids ?? [])
      .map(department)
      .filter((item): item is OrgDepartment => item !== null),
    position:
      (person?.position_id && index.positions.get(person.position_id)) || null,
    leads: person
      ? index.order.filter((item) => item.lead_actor_id === actorID)
      : [],
  };
}

function activeLead(index: OrgIndex, department: OrgDepartment) {
  const lead = department.lead_actor_id;
  return lead && index.people.has(lead) ? lead : null;
}

/**
 * «Руководитель» of a person: the lead of their primary department; if they
 * lead it themselves or it has none, the lead of the nearest parent that has
 * one other than the person. Null outside the structure or at the top.
 */
export function managerOf(
  structure: OrgStructure,
  actorID: string,
): string | null {
  const index = orgIndex(structure);
  const primaryID = index.people.get(actorID)?.primary_department_id;
  let department = primaryID ? index.departments.get(primaryID) : undefined;
  const seen = new Set<string>();
  while (department && !seen.has(department.id)) {
    seen.add(department.id);
    const lead = activeLead(index, department);
    if (lead && lead !== actorID) return lead;
    department = department.parent_id
      ? index.departments.get(department.parent_id)
      : undefined;
  }
  return null;
}

/**
 * «Подчинённые»: members of the departments the person leads and the leads
 * of their direct subdepartments, without the person, no repeats.
 */
export function subordinatesOf(
  structure: OrgStructure,
  actorID: string,
): string[] {
  const index = orgIndex(structure);
  const result = new Set<string>();
  for (const department of index.order) {
    if (activeLead(index, department) !== actorID) continue;
    for (const membership of index.members.get(department.id) ?? [])
      result.add(membership.actorID);
    for (const child of index.children.get(department.id) ?? []) {
      const lead = activeLead(index, child);
      if (lead) result.add(lead);
    }
  }
  result.delete(actorID);
  return [...result];
}

type OrgLinePerson = Pick<ActorSummary, "actor_id" | "handle" | "title"> & {
  position_id?: string | null;
};

/**
 * The line under a name (decision 3): the position from the structure, else
 * the person's own caption (`title`), else @handle.
 */
export function personOrgLine(
  person: OrgLinePerson,
  structure?: OrgStructure | null,
): string {
  if (structure) {
    const index = orgIndex(structure);
    const positionID =
      index.people.get(person.actor_id)?.position_id ?? person.position_id;
    const position = positionID ? index.positions.get(positionID) : undefined;
    if (position) return position.name;
  }
  const title = person.title?.trim();
  if (title) return title;
  return `@${person.handle}`;
}

/** Names of a person's position and departments, for searching people. */
export function personOrgSearchText(
  structure: OrgStructure,
  actorID: string,
  fallbackPositionID?: string | null,
): string {
  const index = orgIndex(structure);
  const org = personOrg(structure, actorID);
  const position =
    org.position ??
    (fallbackPositionID ? index.positions.get(fallbackPositionID) : null);
  return [
    position?.name,
    org.primary?.name,
    ...org.additional.map((department) => department.name),
  ]
    .filter(Boolean)
    .join(" ");
}

// ---------------------------------------------------------------------------
// «Люди», grouped

type GroupedPerson = Pick<ActorSummary, "actor_id" | "display_name" | "type">;

export type PeopleGroupEntry<T> = {
  person: T;
  /** «рук.»: leads this department. */
  lead: boolean;
  /** «совм.»: an additional member of this department. */
  additional: boolean;
};

export type PeopleGroup<T> =
  | {
      kind: "department";
      department: OrgDepartment;
      /** Parents only: «Реабилитация», empty at the top level. */
      path: string;
      entries: PeopleGroupEntry<T>[];
    }
  | { kind: "none"; entries: PeopleGroupEntry<T>[] };

/** The «Без отдела» value of the department filter. */
export const noDepartment = null;

/**
 * «Люди» grouped by department, in tree order. In each group the lead comes
 * first with «рук.», then people by name; someone with additional
 * departments appears in each of them with «совм.». People without a
 * department come last in «Без отдела». Agents are not part of the
 * structure and are left out: the client lists them separately.
 *
 * `departmentID` narrows to one department (with its subdepartments unless
 * `nested: false`); `noDepartment` (null) leaves only «Без отдела». Filter
 * by the query first (filterPeople with the structure). Empty groups are
 * not returned.
 */
export function groupPeopleByDepartment<T extends GroupedPerson>(
  people: readonly T[],
  structure: OrgStructure,
  filter: { departmentID?: string | null; nested?: boolean } = {},
): PeopleGroup<T>[] {
  const index = orgIndex(structure);
  const humans = people.filter((person) => person.type === "user");
  const byID = new Map(humans.map((person) => [person.actor_id, person]));
  const wanted =
    filter.departmentID === undefined
      ? null
      : filter.departmentID === null
        ? new Set<string>()
        : new Set(
            filter.nested === false
              ? index.departments.has(filter.departmentID)
                ? [filter.departmentID]
                : []
              : departmentSubtree(structure, filter.departmentID),
          );
  const groups: PeopleGroup<T>[] = [];
  for (const department of index.order) {
    if (wanted && !wanted.has(department.id)) continue;
    const lead = activeLead(index, department);
    const entries = (index.members.get(department.id) ?? [])
      .filter((membership) => byID.has(membership.actorID))
      .map((membership) => ({
        person: byID.get(membership.actorID)!,
        lead: membership.actorID === lead,
        additional: !membership.primary,
      }))
      .sort(
        (left, right) =>
          Number(right.lead) - Number(left.lead) ||
          collator.compare(left.person.display_name, right.person.display_name),
      );
    if (!entries.length) continue;
    groups.push({
      kind: "department",
      department,
      path: departmentPath(structure, department.id, { includeSelf: false }),
      entries,
    });
  }
  if (filter.departmentID === undefined || filter.departmentID === null) {
    const entries = humans
      .filter(
        (person) => !index.people.get(person.actor_id)?.primary_department_id,
      )
      .sort((left, right) =>
        collator.compare(left.display_name, right.display_name),
      )
      .map((person) => ({ person, lead: false, additional: false }));
    if (entries.length) groups.push({ kind: "none", entries });
  }
  return groups;
}

/** People without a primary department, for «Люди без отдела» in settings. */
export function peopleWithoutDepartment<T extends GroupedPerson>(
  people: readonly T[],
  structure: OrgStructure,
): T[] {
  const index = orgIndex(structure);
  return people.filter(
    (person) =>
      person.type === "user" &&
      !index.people.get(person.actor_id)?.primary_department_id,
  );
}

// ---------------------------------------------------------------------------
// Search

export type OrgSearchResult = {
  departments: { department: OrgDepartment; path: string }[];
  positions: OrgPosition[];
};

/** Departments and positions whose name has every word of the query. */
export function searchOrg(
  structure: OrgStructure,
  query: string,
): OrgSearchResult {
  const index = orgIndex(structure);
  if (!queryWords(query).length) return { departments: [], positions: [] };
  return {
    departments: index.order
      .filter((department) => orgNameMatches(department.name, query))
      .map((department) => ({
        department,
        path: departmentPath(structure, department.id, { includeSelf: false }),
      })),
    positions: index.positionOrder.filter((position) =>
      orgNameMatches(position.name, query),
    ),
  };
}

// ---------------------------------------------------------------------------
// Editing helpers

/**
 * Departments a department may move under («Входит в»): not itself, not its
 * subdepartments, and not so deep that its subtree would pass 8 levels.
 * The top level (`parent_id: null`) is always possible.
 */
export function departmentParentOptions(
  structure: OrgStructure,
  departmentID: string,
): OrgDepartment[] {
  const index = orgIndex(structure);
  const subtree = new Set(departmentSubtree(structure, departmentID));
  const ownDepth = index.depth.get(departmentID) ?? 0;
  let height = 0;
  for (const id of subtree)
    height = Math.max(height, (index.depth.get(id) ?? 0) - ownDepth);
  return index.order.filter(
    (department) =>
      !subtree.has(department.id) &&
      (index.depth.get(department.id) ?? 0) + 1 + height < orgMaxDepth,
  );
}

/**
 * Where primary members go when a department is deleted (decision 12): any
 * other department, or «без отдела» (`"none"`). The default is the parent,
 * «без отдела» for a top-level department.
 */
export function departmentDeletionTargets(
  structure: OrgStructure,
  departmentID: string,
): { options: OrgDepartment[]; defaultTarget: string | "none" } {
  const index = orgIndex(structure);
  const parent = index.departments.get(departmentID)?.parent_id;
  return {
    options: index.order.filter((department) => department.id !== departmentID),
    defaultTarget: parent && index.departments.has(parent) ? parent : "none",
  };
}

/** «Выше» and «Ниже» in the department menu: among siblings. */
export function departmentMoves(
  structure: OrgStructure,
  departmentID: string,
): { up: boolean; down: boolean } {
  const index = orgIndex(structure);
  const department = index.departments.get(departmentID);
  if (!department) return { up: false, down: false };
  const parent =
    department.parent_id && index.departments.has(department.parent_id)
      ? department.parent_id
      : null;
  const siblings = index.children.get(parent) ?? [];
  const at = siblings.findIndex((item) => item.id === departmentID);
  return { up: at > 0, down: at >= 0 && at < siblings.length - 1 };
}

export type DepartmentChatState =
  /** The reader is in the chat: open it. */
  | { kind: "open"; chatID: string; archived: boolean }
  /** A chat exists, the reader is not in it: ask the lead. */
  | { kind: "notMember"; archived: boolean }
  /** No chat; the reader may create or link one. */
  | { kind: "create" }
  /** No chat, nothing to offer. */
  | { kind: "none" };

/** May create or link the department chat and add the missing people. */
export function canManageDepartmentChat(
  user: User,
  department: OrgDepartment,
): boolean {
  return canManageOrg(user) || department.lead_actor_id === user.id;
}

/** The chat row of a department card. */
export function departmentChatState(
  user: User,
  department: OrgDepartment,
): DepartmentChatState {
  if (department.chat_id)
    return {
      kind: "open",
      chatID: department.chat_id,
      archived: department.chat_archived,
    };
  if (department.has_chat)
    return { kind: "notMember", archived: department.chat_archived };
  return canManageDepartmentChat(user, department)
    ? { kind: "create" }
    : { kind: "none" };
}

// ---------------------------------------------------------------------------
// Cache and realtime

/**
 * Reads GET /org with the cached version as `If-None-Match`; on 304 keeps
 * the cached structure (the same object, so memoised views stay).
 */
export async function fetchOrgStructure(
  api: Pick<MessengerAPI, "orgStructure">,
  cached?: OrgStructure | null,
): Promise<OrgStructure> {
  const fresh = await api.orgStructure(cached?.version);
  if (fresh) return fresh;
  if (cached) return cached;
  // 304 without a cached copy cannot happen; read once more without it.
  const again = await api.orgStructure();
  if (!again) throw new Error("org structure: 304 without a cached copy");
  return again;
}

/** data of org.updated, or null for any other event or a malformed one. */
export function parseOrgUpdated(
  event: Pick<DurableEvent, "type" | "data">,
): OrgUpdatedEvent | null {
  if (event.type !== "org.updated") return null;
  const { version, reason } = event.data;
  if (typeof version !== "number" || !Number.isFinite(version)) return null;
  if (
    reason !== "department" &&
    reason !== "position" &&
    reason !== "membership" &&
    reason !== "person_status"
  )
    return null;
  return { version, reason };
}

export type OrgEventEffect =
  /** The cache already has this version or newer. */
  | { kind: "skip" }
  /** Read GET /org again after `delayMs`, gathering a burst. */
  | { kind: "refetch"; version: number; delayMs: number };

/**
 * What org.updated means for the cache: skip it when its version is not
 * newer than the cached one, else read again after 500 ms. Null for other
 * events.
 */
export function orgEventEffect(
  event: Pick<DurableEvent, "type" | "data">,
  cachedVersion: number | null | undefined,
): OrgEventEffect | null {
  const data = parseOrgUpdated(event);
  if (!data) return null;
  if (cachedVersion != null && data.version <= cachedVersion)
    return { kind: "skip" };
  return { kind: "refetch", version: data.version, delayMs: orgRefetchDelayMs };
}

export type OrgSync = {
  /** The cached structure; null before the first read. */
  current(): OrgStructure | null;
  /** Reads GET /org now (one request at a time) and returns the result. */
  refresh(): Promise<OrgStructure>;
  /** Feed every durable event; true when it scheduled a read. */
  handleEvent(event: Pick<DurableEvent, "type" | "data">): boolean;
  /** After a write: its response `version`; reads again if it is newer. */
  noteVersion(version: number): void;
  /** Called with every new structure; returns the unsubscribe. */
  subscribe(listener: (structure: OrgStructure) => void): () => void;
  dispose(): void;
};

/**
 * The org structure kept current for a client without a query library: the
 * cache by version with ETag/304, org.updated gathered for 500 ms, and a
 * write's version applied. A client with TanStack Query can instead use
 * fetchOrgStructure as the query function under orgKeys.all and
 * orgEventEffect to invalidate it.
 */
export function createOrgSync(
  api: Pick<MessengerAPI, "orgStructure">,
  options: {
    initial?: OrgStructure | null;
    delayMs?: number;
    onError?: (error: unknown) => void;
    setTimer?: (run: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
  } = {},
): OrgSync {
  const delayMs = options.delayMs ?? orgRefetchDelayMs;
  const setTimer =
    options.setTimer ?? ((run: () => void, ms: number) => setTimeout(run, ms));
  const clearTimer =
    options.clearTimer ??
    ((handle: unknown) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>));
  let structure = options.initial ?? null;
  let wanted = structure?.version ?? 0;
  let timer: unknown = null;
  let inflight: Promise<OrgStructure> | null = null;
  let retries = 0;
  let disposed = false;
  const listeners = new Set<(structure: OrgStructure) => void>();

  const schedule = () => {
    if (disposed || timer !== null) return;
    timer = setTimer(() => {
      timer = null;
      refresh().catch((error) => options.onError?.(error));
    }, delayMs);
  };

  const refresh = (): Promise<OrgStructure> => {
    if (inflight) return inflight;
    const run = fetchOrgStructure(api, structure)
      .then((next) => {
        if (disposed) return next;
        const changed = next !== structure;
        structure = next;
        if (changed) listeners.forEach((listener) => listener(next));
        // The event may have come from a newer transaction than the replica
        // answered; try a couple more times, then trust the server.
        if (next.version < wanted && retries < 2) {
          retries += 1;
          schedule();
        } else {
          retries = 0;
          wanted = Math.max(wanted, next.version);
        }
        return next;
      })
      .finally(() => {
        inflight = null;
      });
    inflight = run;
    return run;
  };

  const want = (version: number) => {
    if (structure && version <= structure.version) return false;
    wanted = Math.max(wanted, version);
    retries = 0;
    schedule();
    return true;
  };

  return {
    current: () => structure,
    refresh,
    handleEvent(event) {
      const effect = orgEventEffect(event, structure?.version);
      return effect?.kind === "refetch" ? want(effect.version) : false;
    },
    noteVersion: (version) => void want(version),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      listeners.clear();
    },
  };
}
