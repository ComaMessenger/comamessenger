import type { Chat } from "@comamessenger/core";

export type SubstituteChip = { actorID: string; name: string };

/**
 * The quick chips of «Вместо меня» (phase 6.7, telephone A: «Марина С.,
 * Олег Ч., Никого»): the substitute already chosen, then the people of the
 * most recent direct chats, without agents and the person themselves.
 * «Выбрать…» finds anyone else.
 */
export function substituteChips(
  chats: readonly Pick<Chat, "kind" | "direct_peer" | "last_activity_seq">[],
  options: {
    selfID: string;
    chosen: SubstituteChip | null;
    limit?: number;
  },
): SubstituteChip[] {
  const limit = options.limit ?? 2;
  const chips: SubstituteChip[] = options.chosen ? [options.chosen] : [];
  const recent = chats
    .filter(
      (chat) =>
        chat.kind === "direct" &&
        chat.direct_peer?.type === "user" &&
        chat.direct_peer.actor_id !== options.selfID,
    )
    .sort((a, b) => b.last_activity_seq - a.last_activity_seq);
  for (const chat of recent) {
    if (chips.length >= limit + (options.chosen ? 1 : 0)) break;
    const peer = chat.direct_peer!;
    if (chips.some((chip) => chip.actorID === peer.actor_id)) continue;
    chips.push({ actorID: peer.actor_id, name: peer.display_name });
  }
  return chips;
}

/** «Марина С.»: the first name and the surname's initial, as on the chips. */
export function shortName(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return words[0] ?? "";
  return `${words[0]} ${words[words.length - 1]![0]!.toLocaleUpperCase()}.`;
}

/** The last emoji typed in the «свой эмодзи» field; empty when none. */
export function lastEmoji(value: string): string {
  const segments =
    typeof Intl !== "undefined" && "Segmenter" in Intl
      ? [
          ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
            value,
          ),
        ].map((part) => part.segment)
      : [...value];
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]!;
    if (/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(segment))
      return segment;
  }
  return "";
}
