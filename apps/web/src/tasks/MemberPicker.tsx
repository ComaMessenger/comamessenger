import { useState, type RefObject } from "react";
import { Check, UserX } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  awayPickerHint,
  foldOrgText,
  visibleSubstitute,
  withCurrentAway,
  type ChatMember,
} from "@comamessenger/core";
import { FloatingPopover, cx } from "../ui";
import { calendarLocale } from "../requests/format";
import { AwayAvatar } from "../status/AwayAvatar";
import { useAwayLookup } from "../status/useAway";

/** Who may be offered: a chat member or a person of the workspace. */
export type PickerPerson = Pick<
  ChatMember,
  "actor_id" | "display_name" | "handle" | "title" | "avatar_version" | "type"
> & { away?: ChatMember["away"] };

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
  members: readonly PickerPerson[];
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
  const away = useAwayLookup();
  const now = new Date();
  const locale = calendarLocale();
  const people = members
    .filter((member) => member.type === "user")
    .map((member) => withCurrentAway(member, away.overrides));
  const inList = new Map(people.map((member) => [member.actor_id, member]));
  // The substitute is offered only when they may be picked here too.
  const hintOf = (member: PickerPerson) =>
    awayPickerHint(
      member,
      visibleSubstitute(
        member.away,
        (id) => inList.get(id) ?? away.lookup(id),
        now,
      ),
      now,
      locale,
    );
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
          {shown.map((member) => {
            const hint = hintOf(member);
            const choose =
              hint?.choose && inList.has(hint.choose.actorID)
                ? hint.choose
                : null;
            return (
              <div key={member.actor_id} className="task-picker__item">
                <button
                  type="button"
                  role="option"
                  aria-selected={selected === member.actor_id}
                  className={cx(
                    "task-picker__row",
                    selected === member.actor_id && "task-picker__row--on",
                  )}
                  onClick={() => onPick(member.actor_id)}
                >
                  <AwayAvatar
                    name={member.display_name}
                    seed={member.actor_id}
                    actorID={member.actor_id}
                    avatarVersion={member.avatar_version}
                    away={member.away}
                    now={now}
                    size="xs"
                  />
                  <span className="task-picker__name">
                    <strong className="truncate">
                      {member.actor_id === selfID
                        ? t("taskPickerMe", { name: member.display_name })
                        : member.display_name}
                    </strong>
                    {hint ? (
                      <small className="truncate away-note">{hint.text}</small>
                    ) : (
                      member.title && (
                        <small className="truncate">{member.title}</small>
                      )
                    )}
                  </span>
                  {selected === member.actor_id && <Check aria-hidden="true" />}
                </button>
                {choose && (
                  <button
                    type="button"
                    className="away-choose"
                    onClick={() => onPick(choose.actorID)}
                  >
                    {choose.label}
                  </button>
                )}
              </div>
            );
          })}
          {!shown.length && (
            <p className="task-picker__empty">{t("taskPickerEmpty")}</p>
          )}
        </div>
      </div>
    </FloatingPopover>
  );
}
