import { useState, type RefObject } from "react";
import { Check, UserX } from "lucide-react";
import { useTranslation } from "react-i18next";
import { foldOrgText, type ChatMember } from "@comamessenger/core";
import { Avatar, FloatingPopover, cx } from "../ui";

/**
 * A person of the chat for a task: the responsible one or an item's
 * assignee. Only people (no agents) of this chat are offered, as the server
 * accepts no one else.
 */
export function MemberPicker({
  anchorRef,
  members,
  selfID,
  selected,
  label,
  noneLabel,
  onPick,
  onDismiss,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  members: readonly ChatMember[];
  selfID: string;
  selected: string | null;
  label: string;
  /** Nobody: shown when the choice may be cleared. */
  noneLabel?: string;
  onPick(actorID: string | null): void;
  onDismiss(): void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const people = members.filter((member) => member.type === "user");
  const folded = foldOrgText(query.trim());
  const shown = people
    .filter(
      (member) =>
        !folded ||
        foldOrgText(member.display_name).includes(folded) ||
        foldOrgText(member.handle).includes(folded),
    )
    .sort(
      (left, right) =>
        Number(right.actor_id === selfID) - Number(left.actor_id === selfID) ||
        left.display_name.localeCompare(right.display_name),
    );
  return (
    <FloatingPopover
      anchorRef={anchorRef}
      placement="bottom-start"
      width={280}
      className="task-picker"
      onDismiss={onDismiss}
    >
      <div role="dialog" aria-label={label}>
        <input
          className="request-input task-picker__search"
          autoFocus
          value={query}
          aria-label={t("taskPickerSearch")}
          placeholder={t("taskPickerSearch")}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") onDismiss();
            if (event.key === "Enter" && shown[0]) {
              event.preventDefault();
              onPick(shown[0].actor_id);
            }
          }}
        />
        <div className="task-picker__list" role="listbox" aria-label={label}>
          {noneLabel && (
            <button
              type="button"
              role="option"
              aria-selected={selected === null}
              className="task-picker__row"
              onClick={() => onPick(null)}
            >
              <UserX aria-hidden="true" className="task-picker__none" />
              <span className="truncate">{noneLabel}</span>
              {selected === null && <Check aria-hidden="true" />}
            </button>
          )}
          {shown.map((member) => (
            <button
              key={member.actor_id}
              type="button"
              role="option"
              aria-selected={selected === member.actor_id}
              className={cx(
                "task-picker__row",
                selected === member.actor_id && "task-picker__row--on",
              )}
              onClick={() => onPick(member.actor_id)}
            >
              <Avatar
                name={member.display_name}
                seed={member.actor_id}
                actorID={member.actor_id}
                avatarVersion={member.avatar_version}
                size="xs"
              />
              <span className="task-picker__name">
                <strong className="truncate">
                  {member.actor_id === selfID
                    ? t("taskPickerMe", { name: member.display_name })
                    : member.display_name}
                </strong>
                {member.title && (
                  <small className="truncate">{member.title}</small>
                )}
              </span>
              {selected === member.actor_id && <Check aria-hidden="true" />}
            </button>
          ))}
          {!shown.length && (
            <p className="task-picker__empty">{t("taskPickerEmpty")}</p>
          )}
        </div>
      </div>
    </FloatingPopover>
  );
}
