import { useTranslation } from "react-i18next";
import {
  departmentMentionNoteText,
  departmentMentionNotes,
  type Message,
  type OrgStructure,
} from "@comamessenger/core";
import { sentWithDepartmentsHere } from "./mentions";

/**
 * "5 people from the department notified · only you see this" under the
 * author's own message (prototype tab F): only for messages sent from this
 * tab, from `mentioned_departments` the server returned.
 */
export function DepartmentMentionNote({
  message,
  viewerID,
  structure,
}: {
  message: Message;
  viewerID: string;
  structure: OrgStructure | null;
}) {
  const { t, i18n } = useTranslation();
  if (!sentWithDepartmentsHere(message.client_msg_id)) return null;
  const notes = departmentMentionNotes(message, viewerID, structure);
  if (!notes.length) return null;
  const locale = i18n.language === "ru" ? "ru" : "en";
  return (
    <div className="org-mention-note" role="status">
      {notes.map((note) => (
        <p key={note.departmentID}>
          {t("orgMentionNote", {
            text: departmentMentionNoteText(note, locale),
          })}
        </p>
      ))}
    </div>
  );
}
