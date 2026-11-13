import type { ActorSummary, ChatMember } from "./types";

/**
 * Searching and ordering people and agents of the workspace: the people
 * directory, the «new message» picker and the members of a chat.
 */
export type PersonPresence = "online" | "away" | "offline";
export type PeopleFilter = "all" | "online" | "people" | "agents";

type Person = Pick<
  ActorSummary,
  "actor_id" | "display_name" | "handle" | "title" | "type"
>;

/** Lower case, «ё» as «е», no leading «@»: how both sides are compared. */
export function normalizeSearch(value: string) {
  return value.trim().toLocaleLowerCase().replace(/ё/g, "е").replace(/^@+/, "");
}

/** Every word of the query is found in the name, the handle or the job title. */
export function matchesPerson(person: Person, query: string) {
  const words = normalizeSearch(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = [person.display_name, person.handle, person.title]
    .map((value) => normalizeSearch(value ?? ""))
    .join(" ");
  return words.every((word) => haystack.includes(word.replace(/^@+/, "")));
}

/** Online people first, then away, then offline, agents last; by name inside. */
export function personRank(person: Person, presence?: PersonPresence) {
  if (person.type === "agent") return 3;
  if (presence === "online") return 0;
  if (presence === "away") return 1;
  return 2;
}

export function sortPeople<T extends Person>(
  people: readonly T[],
  presence: Readonly<Record<string, PersonPresence>> = {},
  locale?: string,
): T[] {
  return [...people].sort(
    (left, right) =>
      personRank(left, presence[left.actor_id]) -
        personRank(right, presence[right.actor_id]) ||
      left.display_name.localeCompare(right.display_name, locale, {
        sensitivity: "base",
      }),
  );
}

export function filterPeople<T extends Person>(
  people: readonly T[],
  options: {
    query?: string;
    filter?: PeopleFilter;
    presence?: Readonly<Record<string, PersonPresence>>;
    /** Hidden: the reader, members already chosen or already in the chat. */
    exclude?: Iterable<string>;
  } = {},
): T[] {
  const hidden = new Set(options.exclude ?? []);
  const presence = options.presence ?? {};
  const filter = options.filter ?? "all";
  return people.filter((person) => {
    if (hidden.has(person.actor_id)) return false;
    if (filter === "people" && person.type !== "user") return false;
    if (filter === "agents" && person.type !== "agent") return false;
    if (
      filter === "online" &&
      (person.type !== "user" || presence[person.actor_id] !== "online")
    )
      return false;
    return matchesPerson(person, options.query ?? "");
  });
}

/** Directory pages may repeat an actor at the page border; the first copy wins. */
export function uniquePeople<T extends Pick<ActorSummary, "actor_id">>(
  people: readonly T[],
): T[] {
  const seen = new Set<string>();
  return people.filter((person) => {
    if (seen.has(person.actor_id)) return false;
    seen.add(person.actor_id);
    return true;
  });
}

const roleRank: Record<string, number> = { owner: 0, admin: 1, member: 2 };

/** Members of a chat: owners, admins, people, agents; by name inside. */
export function sortChatMembers(
  members: readonly ChatMember[],
  locale?: string,
): ChatMember[] {
  return [...members].sort(
    (left, right) =>
      (roleRank[left.role] ?? 2) - (roleRank[right.role] ?? 2) ||
      Number(left.type === "agent") - Number(right.type === "agent") ||
      left.display_name.localeCompare(right.display_name, locale, {
        sensitivity: "base",
      }),
  );
}

/** Online people in a list of members, for «9 участников · 4 в сети». */
export function onlineCount(
  people: readonly Person[],
  presence: Readonly<Record<string, PersonPresence>>,
) {
  return people.filter(
    (person) =>
      person.type === "user" && presence[person.actor_id] === "online",
  ).length;
}
