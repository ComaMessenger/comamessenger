import { StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import {
  departmentMentionNoteText,
  departmentMentionNotes,
  type ClientMessage,
} from "@comamessenger/core";
import { useSignedIn } from "@/session/SessionProvider";
import { Text } from "@/ui/Text";
import { useOrg } from "./useOrg";

/**
 * Messages with @отдел sent from this phone since the app started. The
 * note «Уведомлены N человек из отдела …» is for the author right after
 * sending, not a permanent part of the feed (as in tab F of the prototype).
 */
const sentThisSession = new Set<string>();

export function noteSentMessage(clientMsgID: string) {
  sentThisSession.add(clientMsgID);
}

/**
 * Under the author's own message of this session: how many people of each
 * mentioned department were notified, «видно только вам».
 */
export function DepartmentMentionNotes({
  message,
}: {
  message: Pick<ClientMessage, "actor_id" | "body" | "client_msg_id"> & {
    mentioned_departments?: ClientMessage["mentioned_departments"];
  };
}) {
  const { t, i18n } = useTranslation();
  const { user } = useSignedIn();
  const { structure } = useOrg();
  if (!message.client_msg_id || !sentThisSession.has(message.client_msg_id))
    return null;
  const notes = departmentMentionNotes(message, user.id, structure);
  if (!notes.length) return null;
  const locale = i18n.language === "ru" ? "ru" : "en";
  return (
    <View testID="department-mention-note" style={styles.wrap}>
      {notes.map((note) => (
        <Text
          key={note.departmentID}
          tone="muted"
          size={12.5}
          style={styles.line}
          accessibilityLiveRegion="polite"
        >
          {`${departmentMentionNoteText(note, locale)} · ${t("orgMentionNoteSuffix")}`}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  // Prototype: `.sysl { font-size: 12.5px; padding: 4px 24px; margin: 4px 0 }`.
  wrap: { alignItems: "center", marginVertical: 4, paddingHorizontal: 24 },
  line: { textAlign: "center", lineHeight: 17 },
});
