import { Pressable, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import {
  awayKindEmoji,
  awayPickerHint,
  currentAway,
  visibleSubstitute,
  withCurrentAway,
  type ChatMember,
} from "@comamessenger/core";
import { useTheme } from "@/lib/theme";
import { Text } from "@/ui/Text";
import { calendarLocale } from "@/requests/locale";
import { useAwayLookup, useAwayNow } from "./useAway";

/**
 * Under the chosen recipients of a request or the responsible person of a
 * task (decision 6): «Анна в отпуске до 30 ноября · замещает Марина» with
 * «Выбрать Марину». Nothing is redirected by itself; the author chooses.
 */
export function AwayPickerHints({
  chosen,
  people,
  withinPeople = false,
  onChoose,
}: {
  chosen: readonly string[];
  people: readonly ChatMember[];
  /**
   * Only `people` may be chosen (a request asks members of its chat): a
   * substitute outside them is named but not offered.
   */
  withinPeople?: boolean;
  /** Replace `away` with `substitute`. */
  onChoose(away: string, substitute: string): void;
}) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const locale = calendarLocale(i18n.language);
  const { on, lookup, overrides } = useAwayLookup();
  const now = useAwayNow(
    chosen.map((id) =>
      currentAway(
        id,
        people.find((person) => person.actor_id === id)?.away,
        overrides,
      ),
    ),
  );
  if (!on) return null;
  const hints = chosen.flatMap((id) => {
    const member = people.find((person) => person.actor_id === id);
    if (!member) return [];
    const person = withCurrentAway(member, overrides);
    const substitute = visibleSubstitute(
      person.away,
      (actorID) => {
        const inside = people.find((item) => item.actor_id === actorID);
        return inside
          ? withCurrentAway(inside, overrides)
          : (lookup(actorID) ?? null);
      },
      now,
    );
    const found = awayPickerHint(person, substitute, now, locale);
    const outside =
      withinPeople &&
      substitute &&
      !people.some((item) => item.actor_id === substitute.actor_id);
    const hint = found && outside ? { ...found, choose: null } : found;
    return hint && person.away
      ? [
          {
            id,
            name: person.display_name,
            emoji: awayKindEmoji[person.away.kind],
            hint,
          },
        ]
      : [];
  });
  if (!hints.length) return null;
  return (
    <View style={styles.list} testID="away-picker-hints">
      {hints.map((item) => (
        <View
          key={item.id}
          style={[styles.hint, { backgroundColor: theme.warningSoft }]}
        >
          <Text size={15} allowFontScaling={false}>
            {item.emoji}
          </Text>
          <View style={styles.body}>
            <Text size={13}>{`${item.name}: ${item.hint.text}`}</Text>
            {item.hint.choose ? (
              <Pressable
                testID="away-picker-choose"
                accessibilityRole="button"
                hitSlop={8}
                onPress={() => onChoose(item.id, item.hint.choose!.actorID)}
              >
                <Text tone="primary" weight="semibold" size={13}>
                  {item.hint.choose.label}
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
  list: { gap: 6, marginTop: 8 },
  hint: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 12,
  },
  body: { flex: 1, minWidth: 0, gap: 2 },
});
