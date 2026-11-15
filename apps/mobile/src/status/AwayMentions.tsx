import { useEffect, useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import {
  awayKindEmoji,
  currentAway,
  mentionAwayHints,
  type ChatMember,
  type ClientMessage,
} from "@comamessenger/core";
import { spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { Text } from "@/ui/Text";
import { calendarLocale } from "@/requests/locale";
import { useAwayLookup, useAwayNow } from "./useAway";

export type AwayMentionHint = ReturnType<typeof mentionAwayHints>[number] & {
  /** The kind's mark, as in the prototype's `.hint2 .e`. */
  emoji: string;
};

/**
 * The lines over the composer for everyone away among the people mentioned
 * in the draft (decision 8). Empty on servers without actor_away.
 */
export function useAwayMentionHints(
  body: string,
  members: readonly ChatMember[],
): AwayMentionHint[] {
  const { i18n } = useTranslation();
  const { on, lookup, overrides } = useAwayLookup();
  const now = useAwayNow(members.map((member) => member.away));
  const locale = calendarLocale(i18n.language);
  return useMemo(() => {
    if (!on || !body.includes("@")) return [];
    return mentionAwayHints(body, {
      members,
      now,
      locale,
      lookup,
      overrides,
    }).map((hint) => {
      const member = members.find((item) => item.actor_id === hint.actorID);
      const away = currentAway(hint.actorID, member?.away, overrides);
      return { ...hint, emoji: away ? awayKindEmoji[away.kind] : "" };
    });
  }, [body, locale, lookup, members, now, on, overrides]);
}

/*
 * «видно только вам» under the sent message: kept by this device only
 * until the chat is left (decision 8), by the client_msg_id of the message.
 */
const notes = new Map<string, { chatID: string; texts: string[] }>();

export function noteAwaySend(
  chatID: string,
  clientMsgID: string,
  hints: readonly AwayMentionHint[],
) {
  if (hints.length)
    notes.set(clientMsgID, {
      chatID,
      texts: hints.map((hint) =>
        [hint.emoji, hint.text].filter(Boolean).join(" "),
      ),
    });
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
export function AwayMentionNote({
  message,
}: {
  message: Pick<ClientMessage, "client_msg_id" | "deleted_at">;
}) {
  const { t } = useTranslation();
  const note = message.client_msg_id
    ? notes.get(message.client_msg_id)
    : undefined;
  if (!note || message.deleted_at) return null;
  return (
    <View testID="away-mention-note" style={styles.note}>
      {note.texts.map((text, index) => (
        <Text
          key={index}
          tone="muted"
          size={12.5}
          accessibilityLiveRegion="polite"
          style={styles.center}
        >
          {`${text} · ${t("awayMentionOnlyYou")}`}
        </Text>
      ))}
    </View>
  );
}

/**
 * The lines over the composer (prototype `.hint2`): who is away and until
 * when, with «Упомянуть Марину» when the substitute is in the chat, else
 * «Написать: Марина».
 */
export function AwayMentionStrip({
  hints,
  onMention,
  onWrite,
}: {
  hints: readonly AwayMentionHint[];
  onMention(actorID: string, name: string): void;
  onWrite(actorID: string): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  if (!hints.length) return null;
  return (
    <View
      testID="away-mention-hints"
      accessibilityLabel={t("awayHintsLabel")}
      accessibilityLiveRegion="polite"
      style={styles.strip}
    >
      {hints.map((hint) => (
        <View
          key={hint.actorID}
          style={[styles.hint, { backgroundColor: theme.warningSoft }]}
        >
          {hint.emoji ? (
            <Text size={15} allowFontScaling={false}>
              {hint.emoji}
            </Text>
          ) : null}
          <View style={styles.hintBody}>
            <Text testID="away-mention-hint" size={13}>
              {hint.text}
            </Text>
            {hint.substitute ? (
              <Pressable
                testID="away-mention-substitute"
                accessibilityRole="button"
                hitSlop={8}
                onPress={() =>
                  hint.substituteInChat
                    ? onMention(hint.substitute!.actorID, hint.substitute!.name)
                    : onWrite(hint.substitute!.actorID)
                }
              >
                <Text tone="primary" weight="semibold" size={13}>
                  {hint.substituteInChat
                    ? hint.substitute.label
                    : t("awayWriteTo", { name: hint.substitute.name })}
                </Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  strip: { gap: 6, paddingHorizontal: spacing[2], paddingBottom: 6 },
  // `.hint2`: 12 radius on the warning soft, the emoji first.
  hint: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 12,
  },
  hintBody: { flex: 1, minWidth: 0, gap: 2 },
  note: { paddingHorizontal: 24, paddingTop: 2, paddingBottom: 4 },
  center: { textAlign: "center" },
});
