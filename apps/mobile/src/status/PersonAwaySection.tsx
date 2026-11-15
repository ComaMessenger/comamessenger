import { StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import {
  awayKindEmoji,
  awayLine,
  capitalize,
  currentAway,
  isAwayActive,
  isAwayPlanned,
  visibleSubstitute,
  type AwayPublic,
} from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { useOpenDirect } from "@/people/openDirect";
import { Avatar } from "@/ui/Avatar";
import { Button } from "@/ui/Button";
import { Text } from "@/ui/Text";
import { calendarLocale } from "@/requests/locale";
import { useAwayLookup, useAwayNow } from "./useAway";

/**
 * «Отсутствие» in the card of a person (decision 14 and 5): «В отпуске до
 * 30 ноября» or, set ahead, «С 20 по 30 ноября — в отпуске», and who
 * substitutes with «Написать».
 */
export function PersonAwaySection({
  person,
}: {
  person: { actor_id: string; type?: string; away?: AwayPublic | null };
}) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const locale = calendarLocale(i18n.language);
  const { on, lookup, overrides } = useAwayLookup();
  const away =
    person.type === "agent"
      ? null
      : currentAway(person.actor_id, person.away, overrides);
  const now = useAwayNow([away]);
  const direct = useOpenDirect((chatID) => router.push(`/chat/${chatID}`));
  if (!on || !away || (!isAwayActive(away, now) && !isAwayPlanned(away, now)))
    return null;
  const line = capitalize(awayLine(away, now, locale));
  if (!line) return null;
  const substitute = visibleSubstitute(away, lookup, now);
  return (
    <View
      testID="person-away"
      style={[
        styles.section,
        { backgroundColor: theme.surface, borderColor: theme.border },
      ]}
    >
      <Text tone="muted" size={13} weight="semibold">
        {t("memberAwayTitle")}
      </Text>
      <View style={styles.line}>
        <View style={[styles.mark, { backgroundColor: theme.warningSoft }]}>
          <Text size={17} allowFontScaling={false}>
            {awayKindEmoji[away.kind]}
          </Text>
        </View>
        <Text testID="person-away-line" size={15} style={styles.grow}>
          {line}
        </Text>
      </View>
      {substitute ? (
        <View style={styles.line}>
          <Avatar
            name={substitute.display_name}
            seed={substitute.actor_id}
            size={34}
            actorID={substitute.actor_id}
            avatarVersion={substitute.avatar_version}
          />
          <View style={styles.grow}>
            <Text tone="muted" size={12.5}>
              {t("memberAwaySubstitute")}
            </Text>
            <Text testID="person-away-substitute" size={15} numberOfLines={1}>
              {substitute.display_name}
            </Text>
          </View>
          <Button
            testID="person-away-write"
            variant="secondary"
            label={t("memberAwayWrite")}
            pending={direct.opening === substitute.actor_id}
            onPress={() => void direct.open(substitute.actor_id)}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: spacing[2],
    padding: spacing[4],
    borderRadius: radius.xl,
    borderWidth: 1,
  },
  line: { flexDirection: "row", alignItems: "center", gap: 10 },
  mark: {
    width: 34,
    height: 34,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  grow: { flex: 1, minWidth: 0 },
});
