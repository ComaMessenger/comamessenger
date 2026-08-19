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

export function mentionedActorIDs(source: string): string[] {
  return [
    ...new Set(decodeMentions(source).mentions.map(({ actorID }) => actorID)),
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
