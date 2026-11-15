import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  mentionAwayHints,
  mentionSuggestionAway,
  type ChatMember,
  type Message,
} from "@comamessenger/core";
import { calendarLocale } from "../requests/format";
import { useAwayLookup, useAwayNow } from "./useAway";

export type AwayMentionHint = ReturnType<typeof mentionAwayHints>[number];

/**
 * The lines over the composer for everyone away among the people mentioned
 * in the draft (decision 8). Empty on servers without actor_away.
 */
export function useAwayMentionHints(
  body: string,
  members: readonly ChatMember[],
): AwayMentionHint[] {
  const { on, lookup, overrides } = useAwayLookup();
  const now = useAwayNow(members.map((member) => member.away));
  const locale = calendarLocale();
  return useMemo(
    () =>
      on && body.includes("@")
        ? mentionAwayHints(body, {
            members,
            now,
            locale,
            lookup,
            overrides,
          })
        : [],
    [body, locale, lookup, members, now, on, overrides],
  );
}

/** The away mark of a person in the @ menu: "on vacation until 30 November". */
export function useMentionAwayNote() {
  const { on, overrides } = useAwayLookup();
  const locale = calendarLocale();
  return (member: ChatMember): string | null =>
    on ? mentionSuggestionAway(member, new Date(), locale, overrides) : null;
}

/*
 * "only you see this" under the sent message: kept by this tab only until
 * the chat is left (decision 8), by the client_msg_id of the message.
 */
const notes = new Map<string, { chatID: string; texts: string[] }>();

export function noteAwaySend(
  chatID: string,
  clientMsgID: string,
  hints: readonly AwayMentionHint[],
) {
  if (hints.length)
    notes.set(clientMsgID, { chatID, texts: hints.map((hint) => hint.text) });
}

/** Leaving the chat drops its lines. */
export function useForgetAwayNotes(chatID: string) {
  useEffect(
    () => () => {
      for (const [key, value] of notes)
        if (value.chatID === chatID) notes.delete(key);
    },
    [chatID],
  );
}

/** The quiet line under one's own message that mentioned someone away. */
export function AwayMentionNote({ message }: { message: Message }) {
  const { t } = useTranslation();
  const note = message.client_msg_id
    ? notes.get(message.client_msg_id)
    : undefined;
  if (!note || message.deleted_at) return null;
  return (
    <div className="away-mention-note" role="status">
      {note.texts.map((text, index) => (
        <p key={index}>
          {text} · {t("awayMentionOnlyYou")}
        </p>
      ))}
    </div>
  );
}

/**
 * The strip over the composer: one line per person away, with "Mention
 * Marina" when the substitute is in the chat, else "Write to Marina".
 */
export function AwayMentionStrip({
  hints,
  onMention,
  onWrite,
}: {
  hints: readonly AwayMentionHint[];
  onMention(actorID: string, name: string): void;
  onWrite?(actorID: string): void;
}) {
  const { t } = useTranslation();
  if (!hints.length) return null;
  return (
    <div
      className="away-hints"
      role="status"
      aria-label={t("awayHintsLabel")}
    >
      {hints.map((hint) => (
        <p key={hint.actorID} className="away-hint">
          <span className="away-hint__text">{hint.text}</span>
          {hint.substitute &&
            (hint.substituteInChat ? (
              <button
                type="button"
                className="away-hint__action"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() =>
                  onMention(hint.substitute!.actorID, hint.substitute!.name)
                }
              >
                {hint.substitute.label}
              </button>
            ) : (
              onWrite && (
                <button
                  type="button"
                  className="away-hint__action"
                  onClick={() => onWrite(hint.substitute!.actorID)}
                >
                  {t("awayWriteTo", { name: hint.substitute.name })}
                </button>
              )
            ))}
        </p>
      ))}
    </div>
  );
}
