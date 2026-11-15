import { departmentPath, expandDepartment, foldOrgText, orgIndex } from "./org";
import type { ChatMember, Message, OrgDepartment, OrgStructure } from "./types";

const mentionPattern = /@\[([^\]]+)\]\(([0-9a-f-]{36})\)/gi;

export type MentionReference = {
  actorID: string;
  label: string;
  start: number;
  end: number;
};

export type MentionDraft = {
  text: string;
  mentions: MentionReference[];
};

export function decodeMentions(source: string): MentionDraft {
  let text = "";
  let cursor = 0;
  const mentions: MentionReference[] = [];
  for (const match of source.matchAll(mentionPattern)) {
    const sourceStart = match.index ?? 0;
    text += source.slice(cursor, sourceStart);
    const label = match[1]!;
    const visible = `@${label}`;
    const start = text.length;
    text += visible;
    mentions.push({
      actorID: match[2]!,
      label,
      start,
      end: start + visible.length,
    });
    cursor = sourceStart + match[0].length;
  }
  text += source.slice(cursor);
  return { text, mentions };
}

export function encodeMentions(draft: MentionDraft): string {
  let result = "";
  let cursor = 0;
  for (const mention of normalizedReferences(draft)) {
    result += draft.text.slice(cursor, mention.start);
    result += `@[${mention.label}](${mention.actorID})`;
    cursor = mention.end;
  }
  return result + draft.text.slice(cursor);
}

export function updateMentionText(
  previous: MentionDraft,
  text: string,
): MentionDraft {
  if (text === previous.text) return previous;
  let prefix = 0;
  while (
    prefix < previous.text.length &&
    prefix < text.length &&
    previous.text[prefix] === text[prefix]
  )
    prefix += 1;
  let oldSuffix = previous.text.length;
  let newSuffix = text.length;
  while (
    oldSuffix > prefix &&
    newSuffix > prefix &&
    previous.text[oldSuffix - 1] === text[newSuffix - 1]
  ) {
    oldSuffix -= 1;
    newSuffix -= 1;
  }
  const shift = newSuffix - oldSuffix;
  const mentions = previous.mentions.flatMap((mention) => {
    if (mention.end <= prefix) return [mention];
    if (mention.start >= oldSuffix)
      return [
        {
          ...mention,
          start: mention.start + shift,
          end: mention.end + shift,
        },
      ];
    return [];
  });
  return { text, mentions };
}

export function insertMention(
  draft: MentionDraft,
  start: number,
  end: number,
  actorID: string,
  rawLabel: string,
): MentionDraft {
  const label = rawLabel.replace(/[\]\r\n]+/g, " ").trim();
  const visible = `@${label}`;
  const text =
    draft.text.slice(0, start) + visible + " " + draft.text.slice(end);
  const shift = visible.length + 1 - (end - start);
  const mentions = draft.mentions
    .filter((mention) => mention.end <= start || mention.start >= end)
    .map((mention) =>
      mention.start >= end
        ? { ...mention, start: mention.start + shift, end: mention.end + shift }
        : mention,
    );
  mentions.push({ actorID, label, start, end: start + visible.length });
  mentions.sort((left, right) => left.start - right.start);
  return { text, mentions };
}

/**
 * People mentioned in the body. A department token (`@[Зал ЛФК](uuid)`, the
 * same form as a person's) is recognised by `departmentIDs` and left out:
 * see mentionedDepartmentIDs.
 */
export function mentionedActorIDs(
  source: string,
  departmentIDs?: Iterable<string>,
): string[] {
  const departments = new Set(departmentIDs ?? []);
  return [
    ...new Set(
      decodeMentions(source)
        .mentions.map(({ actorID }) => actorID)
        .filter((id) => !departments.has(id)),
    ),
  ];
}

/** Departments mentioned in the body, for `mentioned_department_ids`. */
export function mentionedDepartmentIDs(
  source: string,
  departmentIDs: Iterable<string>,
): string[] {
  const departments = new Set(departmentIDs);
  return [
    ...new Set(
      decodeMentions(source)
        .mentions.map(({ actorID }) => actorID)
        .filter((id) => departments.has(id)),
    ),
  ];
}

export function messagePlainText(source: string): string {
  return decodeMentions(source)
    .text.replace(/```([\s\S]*?)```/g, "$1")
    .replace(/^#{1,3}\s+/gm, "")
    .replace(/^\s*(?:[-+*]|\d+\.)\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/\+\+([^+]+)\+\+/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\(https?:\/\/[^\s)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedReferences(draft: MentionDraft): MentionReference[] {
  return [...draft.mentions]
    .sort((left, right) => left.start - right.start)
    .filter(
      (mention, index, all) =>
        mention.start >= 0 &&
        mention.end <= draft.text.length &&
        mention.end > mention.start &&
        draft.text.slice(mention.start, mention.end) === `@${mention.label}` &&
        (index === 0 || mention.start >= all[index - 1]!.end),
    );
}

export type PresenceMap = Record<string, "online" | "away" | "offline">;

/**
 * Expands @all / @here into concrete actor ids in addition to explicit
 * mentions. Departments (by `departmentIDs`) are not people: the server
 * expands them from `mentioned_department_ids`.
 */
export function resolvedMentionActorIDs(
  source: string,
  members: { actor_id: string }[],
  presence: PresenceMap,
  departmentIDs?: Iterable<string>,
) {
  const ids = new Set(mentionedActorIDs(source, departmentIDs));
  const text = decodeMentions(source).text;
  if (/(^|\s)@all\b/i.test(text))
    members.forEach((member) => ids.add(member.actor_id));
  if (/(^|\s)@here\b/i.test(text))
    members
      .filter((member) => presence[member.actor_id] === "online")
      .forEach((member) => ids.add(member.actor_id));
  return [...ids];
}

/** Most departments one message may mention (`mentioned_department_ids`). */
export const maxMentionedDepartments = 10;

/**
 * The mention fields of a message body. Departments go to
 * `mentioned_department_ids` only when the server announced org_structure
 * (`structure` is passed); without it a department token stays a plain
 * mention, as older clients send it.
 */
export function messageMentionFields(
  source: string,
  options: {
    members: { actor_id: string }[];
    presence: PresenceMap;
    structure?: OrgStructure | null;
  },
): { mentioned_actor_ids: string[]; mentioned_department_ids?: string[] } {
  const departmentIDs = options.structure
    ? options.structure.departments.map((department) => department.id)
    : undefined;
  const fields: {
    mentioned_actor_ids: string[];
    mentioned_department_ids?: string[];
  } = {
    mentioned_actor_ids: resolvedMentionActorIDs(
      source,
      options.members,
      options.presence,
      departmentIDs,
    ),
  };
  if (departmentIDs) {
    const departments = mentionedDepartmentIDs(source, departmentIDs);
    if (departments.length) fields.mentioned_department_ids = departments;
  }
  return fields;
}

type SuggestedMember = Pick<
  ChatMember,
  "actor_id" | "display_name" | "handle" | "type"
>;

export type DepartmentMentionSuggestion = {
  department: OrgDepartment;
  /** Parents only, «Реабилитация»; empty at the top level. */
  path: string;
  /** «5 человек из отдела в этом чате»: active, the author left out. */
  inChatCount: number;
};

export type MentionSuggestions<T extends SuggestedMember> = {
  /** Shown first: only departments with someone of this chat (decision 18). */
  departments: DepartmentMentionSuggestion[];
  people: T[];
  /** @all and @here, when the chat has more than one member. */
  context: ("all" | "here")[];
};

/**
 * What the @ menu offers for the typed query (the text after «@»):
 * departments that have at least one person of this chat other than the
 * author, then members, then @all and @here. Without a structure (no
 * org_structure) there are no departments.
 */
export function mentionSuggestions<T extends SuggestedMember>(
  query: string,
  options: {
    members: readonly T[];
    authorID: string;
    structure?: OrgStructure | null;
    /** How many people at most; 6 by default, as the menus show. */
    peopleLimit?: number;
    /** How many departments at most; 5 by default. */
    departmentLimit?: number;
  },
): MentionSuggestions<T> {
  const folded = foldOrgText(query).replace(/^@+/, "");
  const departments: DepartmentMentionSuggestion[] = [];
  if (options.structure) {
    const memberIDs = options.members
      .filter((member) => member.type === "user")
      .map((member) => member.actor_id);
    for (const department of orgIndex(options.structure).order) {
      if (!foldOrgText(department.name).includes(folded)) continue;
      const inChatCount = expandDepartment(options.structure, department.id, {
        chatMemberIDs: memberIDs,
        excludeActorID: options.authorID,
      }).inChat.length;
      if (inChatCount < 1) continue;
      departments.push({
        department,
        path: departmentPath(options.structure, department.id, {
          includeSelf: false,
        }),
        inChatCount,
      });
      if (departments.length >= (options.departmentLimit ?? 5)) break;
    }
  }
  const people = options.members
    .filter(
      (member) =>
        foldOrgText(member.display_name).includes(folded) ||
        foldOrgText(member.handle).includes(folded),
    )
    .slice(0, options.peopleLimit ?? 6);
  const context =
    options.members.length > 1
      ? (["all", "here"] as const).filter((word) => word.startsWith(folded))
      : [];
  return { departments, people, context: [...context] };
}

export type DepartmentMentionNote = {
  departmentID: string;
  /** From the structure, else the label of the token in the body. */
  name: string;
  notifiedCount: number;
};

/**
 * «Уведомлены 5 человек из отдела «Зал ЛФК»» / «Никого из отдела нет в этом
 * чате» under the author's own message (decision 18). Empty for anyone
 * else and for messages without departments.
 */
export function departmentMentionNotes(
  message: Pick<Message, "actor_id" | "body"> & {
    mentioned_departments?: Message["mentioned_departments"];
  },
  viewerID: string,
  structure?: OrgStructure | null,
): DepartmentMentionNote[] {
  if (message.actor_id !== viewerID) return [];
  const mentioned = message.mentioned_departments ?? [];
  if (!mentioned.length) return [];
  const labels = new Map(
    decodeMentions(message.body).mentions.map((mention) => [
      mention.actorID,
      mention.label,
    ]),
  );
  const departments = structure ? orgIndex(structure).departments : null;
  return mentioned.map((item) => ({
    departmentID: item.department_id,
    name:
      departments?.get(item.department_id)?.name ??
      labels.get(item.department_id) ??
      "",
    notifiedCount: item.notified_count,
  }));
}

/** The text of one note, in Russian or English. */
export function departmentMentionNoteText(
  note: DepartmentMentionNote,
  locale: "ru" | "en",
): string {
  const count = note.notifiedCount;
  if (locale === "ru") {
    if (count === 0) return `Никого из отдела «${note.name}» нет в этом чате`;
    const mod10 = count % 10;
    const mod100 = count % 100;
    const verb = mod10 === 1 && mod100 !== 11 ? "Уведомлён" : "Уведомлены";
    const noun =
      mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
        ? "человека"
        : "человек";
    return `${verb} ${count} ${noun} из отдела «${note.name}»`;
  }
  if (count === 0) return `Nobody from ${note.name} is in this chat`;
  return `${count} ${count === 1 ? "person" : "people"} from ${note.name} notified`;
}
