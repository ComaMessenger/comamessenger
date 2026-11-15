import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { ActorSummary, OrgDepartment } from "@comamessenger/core";
import { Avatar } from "../ui";
import { DepartmentIcon } from "./DepartmentIcon";

/** A person in a card: avatar, name with "lead" / "also", a caption. */
export function OrgPersonLink({
  actor,
  caption,
  mark,
  onClick,
}: {
  actor: ActorSummary;
  caption?: ReactNode;
  mark?: ReactNode;
  onClick(): void;
}) {
  return (
    <button type="button" className="org-link" onClick={onClick}>
      <Avatar
        name={actor.display_name}
        seed={actor.actor_id}
        actorID={actor.actor_id}
        avatarVersion={actor.avatar_version}
        size="md"
      />
      <span className="org-link__body">
        <span className="org-link__title">
          <strong className="truncate">{actor.display_name}</strong>
          {mark}
        </span>
        {caption && <small className="truncate">{caption}</small>}
      </span>
      <ChevronRight className="org-link__chevron" aria-hidden="true" />
    </button>
  );
}

/** A department in a card: the mark, name, a caption ("part of", lead · N). */
export function OrgDepartmentLink({
  department,
  caption,
  mark,
  onClick,
}: {
  department: OrgDepartment;
  caption?: ReactNode;
  mark?: ReactNode;
  onClick(): void;
}) {
  return (
    <button type="button" className="org-link" onClick={onClick}>
      <DepartmentIcon />
      <span className="org-link__body">
        <span className="org-link__title">
          <strong className="truncate">{department.name}</strong>
          {mark}
        </span>
        {caption && <small className="truncate">{caption}</small>}
      </span>
      <ChevronRight className="org-link__chevron" aria-hidden="true" />
    </button>
  );
}
