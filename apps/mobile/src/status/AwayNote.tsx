import { useTranslation } from "react-i18next";
import {
  awayKindEmoji,
  awayNote,
  currentAway,
  type AwayPublic,
} from "@comamessenger/core";
import { useTheme } from "@/lib/theme";
import { Text } from "@/ui/Text";
import { calendarLocale } from "@/requests/locale";
import { useAwayNow, useAwayOverrides } from "./useAway";

/**
 * «🌴 в отпуске до 30 ноября» under a name, in the warning colour: the
 * answers of a request, pickers. Nothing when the person is here.
 */
export function AwayNote({
  member,
  size = 12.5,
}: {
  member: { actor_id: string; type?: string; away?: AwayPublic | null };
  size?: number;
}) {
  const { i18n } = useTranslation();
  const theme = useTheme();
  const overrides = useAwayOverrides();
  const away = currentAway(member.actor_id, member.away, overrides);
  const now = useAwayNow([away]);
  const note = awayNote(
    { type: member.type === "agent" ? "agent" : "user", away },
    now,
    calendarLocale(i18n.language),
  );
  if (!note || !away) return null;
  return (
    <Text
      testID="away-note"
      size={size}
      numberOfLines={1}
      style={{ color: theme.warning }}
    >
      {`${awayKindEmoji[away.kind]} ${note}`}
    </Text>
  );
}
