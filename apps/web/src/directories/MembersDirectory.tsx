import { useMemo, useState, type ReactNode } from "react";
import { ChevronDown, Users } from "lucide-react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import {
  departmentPath,
  filterPeople,
  groupPeopleByDepartment,
  orgIndex,
  personOrg,
  personOrgLine,
  type ActorSummary,
  type OrgStructure,
  type PeopleGroup,
} from "@comamessenger/core";
import { hasPermission } from "../settings";
import {
  Avatar,
  Button,
  Chip,
  EmptyState,
  InlineError,
  SearchField,
  Segmented,
  SkeletonRow,
  Tag,
  cx,
} from "../ui";
import { useIsMobile, useIsNarrowDesktop } from "../lib/useMediaQuery";
import { useMessenger } from "../shell/MessengerContext";
import { DirectoryList, DirectoryRow, DirectorySplit } from "./DirectoryPage";
import { MemberProfile } from "./MemberProfile";
import { DepartmentProfile } from "./DepartmentProfile";
import { OrgTree } from "./OrgTree";
import { departmentPathOf } from "./routes";
import { DepartmentIcon, OrgMark } from "../org/DepartmentIcon";
import {
  useActorMap,
  useAllActors,
  useOrgAvailable,
  useOrgStructure,
} from "../org/useOrg";

type Filter = "all" | "online" | "people" | "agents";
type View = "list" | "groups" | "tree";
/** A department id, "No department" (null) or everyone (undefined). */
type DepartmentFilter = string | null | undefined;

const viewKey = "coma-members-view";

function readView(): View {
  try {
    const value = localStorage.getItem(viewKey);
    return value === "groups" || value === "tree" ? value : "list";
  } catch {
    return "list";
  }
}

export function MembersDirectory({
  selectedID,
  selectedDepartmentID,
}: {
  selectedID?: string;
  selectedDepartmentID?: string;
}) {
  const { t } = useTranslation();
  const { api, user, store, navigate } = useMessenger();
  const isMobile = useIsMobile();
  const narrow = useIsNarrowDesktop();
  const presence = useStore(store, (state) => state.presence);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [storedView, setStoredView] = useState<View>(readView);
  const [department, setDepartment] = useState<DepartmentFilter>(undefined);
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());

  const orgAvailable = useOrgAvailable();
  const org = useOrgStructure(api);
  const structure = org.data ?? null;
  const hasOrg = Boolean(orgAvailable && structure?.departments.length);
  const view: View = hasOrg ? storedView : "list";
  const everyone = useAllActors(api, hasOrg);
  const actorMap = useActorMap(everyone.data);

  const query = useInfiniteQuery({
    queryKey: ["actors", "directory"],
    queryFn: ({ pageParam }) => api.actors("", pageParam),
    initialPageParam: "",
    getNextPageParam: (page) => page.next_after_id ?? undefined,
  });
  const actors = useMemo(
    () =>
      (query.data?.pages ?? [])
        .flatMap((page) => page.actors)
        .filter((actor) => actor.actor_id !== user.id),
    [query.data, user.id],
  );
  const humans = actors.filter((actor) => actor.type === "user").length;
  const agents = actors.length - humans;
  const onlineCount = actors.filter(
    (actor) => actor.type === "user" && presence[actor.actor_id] === "online",
  ).length;
  const needle = search.trim();
  const visible = filterPeople(actors, {
    query: needle,
    filter,
    presence,
    structure: orgAvailable ? structure : null,
  });

  function chooseView(next: View) {
    setStoredView(next);
    try {
      localStorage.setItem(viewKey, next);
    } catch {
      // The view is a convenience; private mode just forgets it.
    }
  }

  const people = everyone.data ?? [];
  const firstDepartment = structure
    ? orgIndex(structure).order[0]?.id
    : undefined;
  const autoSelect = !isMobile && !narrow;
  const activeDepartmentID =
    selectedDepartmentID ??
    (!selectedID && autoSelect && view === "tree"
      ? firstDepartment
      : undefined);
  const activeID = activeDepartmentID
    ? undefined
    : (selectedID ??
      (autoSelect && view === "list" ? visible[0]?.actor_id : undefined));
  const active = activeID
    ? (actors.find((actor) => actor.actor_id === activeID) ??
      actorMap.get(activeID))
    : undefined;
  const canInvite = hasPermission(user, "invitations.manage");

  const memberRow = (
    actor: ActorSummary,
    options: { mark?: ReactNode; meta?: string; key?: string } = {},
  ) => {
    const isAgent = actor.type === "agent";
    const state = presence[actor.actor_id] ?? "offline";
    const line =
      options.meta ??
      (orgAvailable
        ? personOrgLine(actor, structure)
        : actor.title || `@${actor.handle}`);
    return (
      <DirectoryRow
        key={options.key ?? actor.actor_id}
        className="directory-row--member"
        selected={!isMobile && actor.actor_id === activeID}
        label={t("openProfile", { name: actor.display_name })}
        leading={
          <Avatar
            name={actor.display_name}
            seed={actor.actor_id}
            actorID={actor.actor_id}
            avatarVersion={actor.avatar_version}
            size="lg"
            agent={isAgent}
            square={isAgent}
            presence={isAgent ? undefined : state}
          />
        }
        title={
          <>
            <span className="directory-member__name truncate">
              {actor.display_name}
            </span>
            {options.mark}
            {isAgent && (
              <Tag tone="agent" size="md">
                {t("memberTagAgent")}
              </Tag>
            )}
          </>
        }
        meta={<span className="truncate">{line}</span>}
        trailing={
          actor.status_emoji ? (
            <span
              className="directory-member__emoji"
              title={actor.status_text || undefined}
            >
              {actor.status_emoji}
            </span>
          ) : undefined
        }
        onClick={() => navigate(`/members/${actor.actor_id}`)}
      />
    );
  };

  const loading = query.isLoading || (view !== "list" && everyone.isLoading);
  const failed = query.isError || (view !== "list" && everyone.isError);

  const viewSwitch = hasOrg && (
    <Segmented<View>
      label={t("orgViewLabel")}
      value={view}
      onChange={chooseView}
      items={[
        { id: "list", label: t("orgViewList") },
        { id: "groups", label: t("orgViewGroups") },
        { id: "tree", label: t("orgViewTree") },
      ]}
    />
  );

  const chips =
    view === "groups" && structure ? (
      <>
        <Chip
          active={department === undefined}
          onClick={() => setDepartment(undefined)}
        >
          {t("membersFilterAll")}
        </Chip>
        {orgIndex(structure).order.map((item) => (
          <Chip
            key={item.id}
            active={department === item.id}
            onClick={() => setDepartment(item.id)}
          >
            {item.name}
          </Chip>
        ))}
        <Chip
          active={department === null}
          onClick={() => setDepartment(null)}
        >
          {t("orgNoDepartment")}
        </Chip>
      </>
    ) : view === "list" && query.data ? (
      <>
        <Chip active={filter === "all"} onClick={() => setFilter("all")}>
          {t("membersFilterAll")}
        </Chip>
        <Chip active={filter === "online"} onClick={() => setFilter("online")}>
          {t("membersFilterOnline", { count: onlineCount })}
        </Chip>
        <Chip active={filter === "people"} onClick={() => setFilter("people")}>
          {t("membersFilterPeople")}
        </Chip>
        <Chip active={filter === "agents"} onClick={() => setFilter("agents")}>
          {t("membersFilterAgents")}
        </Chip>
      </>
    ) : null;

  let body: ReactNode;
  if (loading)
    body = (
      <>
        <SkeletonRow avatar={40} lines={["40%", "60%"]} />
        <SkeletonRow avatar={40} lines={["50%", "45%"]} />
        <SkeletonRow avatar={40} lines={["35%", "70%"]} />
        <SkeletonRow avatar={40} lines={["45%", "55%"]} />
      </>
    );
  else if (failed)
    body = (
      <InlineError
        center
        title={t("threadsLoadFailed")}
        onRetry={() => {
          void query.refetch();
          void everyone.refetch();
        }}
        retryLabel={t("retry")}
      />
    );
  else if (view === "tree" && structure)
    body = (
      <OrgTree
        structure={structure}
        actors={actorMap}
        selectedID={activeDepartmentID}
        query={needle}
        label={t("orgTreeLabel", { name: user.organization_name })}
        onOpen={(id) => navigate(departmentPathOf(id))}
      />
    );
  else if (view === "groups" && structure)
    body = (
      <GroupedPeople
        people={people}
        structure={structure}
        query={needle}
        department={department}
        folded={folded}
        onFold={(id) =>
          setFolded((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          })
        }
        selectedDepartmentID={activeDepartmentID}
        renderRow={memberRow}
        onOpenDepartment={(id) => navigate(departmentPathOf(id))}
      />
    );
  else if (visible.length === 0)
    body = (
      <EmptyState
        icon={<Users />}
        title={t("membersEmpty")}
        hint={t("membersEmptyHint")}
      />
    );
  else
    body = (
      <>
        {visible.map((actor) => memberRow(actor))}
        {query.hasNextPage && !needle && (
          <div className="directory-list__more">
            <Button
              variant="ghost"
              pending={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {t("loadMore")}
            </Button>
          </div>
        )}
      </>
    );

  const list = (
    <DirectoryList
      title={t("members")}
      lead={
        query.data
          ? hasOrg
            ? t("orgMembersLead", {
                humans,
                departments: structure!.departments.length,
              })
            : t("membersLeadShort", { humans, agents })
          : t("membersHint")
      }
      action={
        canInvite && (
          <Button
            size="sm"
            variant="primary"
            onClick={() => navigate("/settings/workspace/invitations")}
          >
            {t("membersInvite")}
          </Button>
        )
      }
      toolbar={
        <>
          {viewSwitch}
          <SearchField
            value={search}
            onChange={setSearch}
            placeholder={
              view === "tree"
                ? t("orgTreeSearch")
                : hasOrg
                  ? t("orgMembersSearch")
                  : t("membersSearch")
            }
            clearLabel={t("clearSearch")}
          />
        </>
      }
      chips={chips}
      className={cx(hasOrg && "directory-list--org")}
    >
      {body}
    </DirectoryList>
  );

  if (isMobile) return list;
  return (
    <DirectorySplit
      list={list}
      detailOpen={Boolean(selectedID || selectedDepartmentID)}
      detail={
        activeDepartmentID && structure ? (
          <DepartmentProfile
            key={activeDepartmentID}
            departmentID={activeDepartmentID}
            structure={structure}
            actors={actorMap}
            onBack={() => navigate("/members")}
          />
        ) : activeDepartmentID && (org.isLoading || everyone.isLoading) ? null : active ? (
          <MemberProfile
            key={active.actor_id}
            actor={active}
            onBack={() => navigate("/members")}
          />
        ) : query.isLoading ? null : (
          <EmptyState
            className="directory-detail__empty"
            icon={<Users />}
            title={t("memberPickTitle")}
            hint={t("memberPickHint")}
          />
        )
      }
    />
  );
}

/**
 * People by department (prototype tab A): a header per department with its
 * path and head count that folds and opens the card, the lead first with
 * "lead", additional members with "also", "No department" last and agents
 * apart. A non-empty search turns into a flat list with the department.
 */
function GroupedPeople({
  people,
  structure,
  query,
  department,
  folded,
  onFold,
  selectedDepartmentID,
  renderRow,
  onOpenDepartment,
}: {
  people: readonly ActorSummary[];
  structure: OrgStructure;
  query: string;
  department: DepartmentFilter;
  folded: ReadonlySet<string>;
  onFold(id: string): void;
  selectedDepartmentID?: string;
  renderRow(
    actor: ActorSummary,
    options?: { mark?: ReactNode; meta?: string; key?: string },
  ): ReactNode;
  onOpenDepartment(id: string): void;
}) {
  const { t } = useTranslation();
  const matching = useMemo(
    () => filterPeople(people, { query, structure }),
    [people, query, structure],
  );
  const groups = useMemo(
    () =>
      groupPeopleByDepartment(
        matching,
        structure,
        department === undefined ? {} : { departmentID: department },
      ),
    [department, matching, structure],
  );
  const agentsList =
    department === undefined
      ? matching.filter((actor) => actor.type === "agent")
      : [];

  if (query) {
    const flat = matching.filter((actor) => {
      if (actor.type === "agent") return department === undefined;
      return groups.some((group) =>
        group.entries.some((entry) => entry.person.actor_id === actor.actor_id),
      );
    });
    if (!flat.length)
      return (
        <EmptyState
          icon={<Users />}
          title={t("membersEmpty")}
          hint={t("membersEmptyHint")}
        />
      );
    return (
      <>
        {flat.map((actor) => {
          const placed = personOrg(structure, actor.actor_id);
          const where = placed.primary
            ? departmentPath(structure, placed.primary.id)
            : actor.type === "agent"
              ? ""
              : t("orgNoDepartment");
          return renderRow(actor, {
            meta: [personOrgLine(actor, structure), where]
              .filter(Boolean)
              .join(" · "),
          });
        })}
      </>
    );
  }

  if (!groups.length && !agentsList.length)
    return (
      <EmptyState
        icon={<Users />}
        title={t("orgGroupsEmpty")}
        hint={t("orgGroupsEmptyHint")}
      />
    );

  const header = (group: PeopleGroup<ActorSummary>) => {
    const id = group.kind === "department" ? group.department.id : "none";
    const isFolded = folded.has(id);
    const title =
      group.kind === "department" ? group.department.name : t("orgNoDepartment");
    const caption = [
      group.kind === "department" ? group.path || t("orgTopLevel") : null,
      t("orgPeopleShort", { count: group.entries.length }),
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <div
        className={cx(
          "org-group",
          group.kind === "department" &&
            group.department.id === selectedDepartmentID &&
            "org-group--selected",
        )}
      >
        {group.kind === "department" ? (
          <button
            type="button"
            className="org-group__open"
            onClick={() => onOpenDepartment(group.department.id)}
            aria-label={t("orgOpenDepartment", { name: title })}
          >
            <DepartmentIcon />
            <span className="org-group__body">
              <strong className="truncate">{title}</strong>
              <small className="truncate">{caption}</small>
            </span>
          </button>
        ) : (
          <span className="org-group__open org-group__open--static">
            <DepartmentIcon />
            <span className="org-group__body">
              <strong className="truncate">{title}</strong>
              <small className="truncate">{caption}</small>
            </span>
          </span>
        )}
        <button
          type="button"
          className={cx("org-group__fold", isFolded && "org-group__fold--closed")}
          aria-label={
            isFolded
              ? t("orgUnfold", { name: title })
              : t("orgFold", { name: title })
          }
          title={
            isFolded
              ? t("orgUnfold", { name: title })
              : t("orgFold", { name: title })
          }
          aria-expanded={!isFolded}
          onClick={() => onFold(id)}
        >
          <ChevronDown aria-hidden="true" />
        </button>
      </div>
    );
  };

  return (
    <>
      {groups.map((group) => {
        const id = group.kind === "department" ? group.department.id : "none";
        return (
          <section key={id} className="org-group-section">
            {header(group)}
            {!folded.has(id) &&
              group.entries.map((entry) =>
                renderRow(entry.person, {
                  key: `${id}:${entry.person.actor_id}`,
                  mark: entry.lead ? (
                    <OrgMark kind="lead">{t("orgMarkLead")}</OrgMark>
                  ) : entry.additional ? (
                    <OrgMark kind="additional">{t("orgMarkAdditional")}</OrgMark>
                  ) : undefined,
                }),
              )}
          </section>
        );
      })}
      {agentsList.length > 0 && (
        <section className="org-group-section">
          <div className="org-group">
            <span className="org-group__open org-group__open--static">
              <span className="org-group__body">
                <strong>{t("orgAgentsGroup")}</strong>
                <small>{t("orgAgentsGroupHint")}</small>
              </span>
            </span>
          </div>
          {agentsList.map((actor) => renderRow(actor))}
        </section>
      )}
    </>
  );
}
