import { useMemo, useState } from "react";
import {
  awayKindEmoji,
  awayLine,
  capitalize,
  isAwayActive,
  isAwayPlanned,
  shownStatus,
  visibleSubstitute,
  withCurrentAway,
  canManageOrg,
  chatAvatarSource,
  departmentPath,
  foldOrgText,
  managerOf,
  personOrg,
  personOrgLine,
  subordinatesOf,
  type OrgStructure,
} from "@comamessenger/core";
import { MessageSquare, Network } from "lucide-react";
import { useQueries } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import type { ActorSummary, Chat } from "@comamessenger/core";
import { Avatar, Button, Tag, cx } from "../ui";
import { titleOf } from "../lib/chats";
import { useMessenger } from "../shell/MessengerContext";
import { DirectoryDetailHead } from "./DirectoryPage";
import { openDirectChat } from "./openDirectChat";
import { departmentPathOf } from "./routes";
import { OrgMark } from "../org/DepartmentIcon";
import { OrgDepartmentLink, OrgPersonLink } from "../org/OrgRows";
import { PersonOrgDialog } from "../org/PersonOrgDialog";
import { calendarLocale } from "../requests/format";
import { AwayAvatar } from "../status/AwayAvatar";
import { useAwayLookup, useAwayNow } from "../status/useAway";
import {
  useActorMap,
  useAllActors,
  useOrgAvailable,
  useOrgStructure,
} from "../org/useOrg";

/** Non-direct chats where both the viewer and the actor are members (one members call per chat, cached). */
function useSharedChats(actorID: string) {
  const { api, store } = useMessenger();
  const chatMap = useStore(store, (state) => state.chats);
  const chats = useMemo(() => Object.values(chatMap), [chatMap]);
  const groupChats = useMemo(
    () => chats.filter((chat) => chat.kind !== "direct").slice(0, 60),
    [chats],
  );
  const results = useQueries({
    queries: groupChats.map((chat) => ({
      queryKey: ["chat-members", chat.id],
      queryFn: () => api.members(chat.id),
      staleTime: 5 * 60_000,
    })),
  });
  const loading = results.some((result) => result.isLoading);
  const shared: Chat[] = groupChats.filter((_, index) =>
    results[index]?.data?.some((member) => member.actor_id === actorID),
  );
  return { shared, loading };
}

/** Member detail: identity, status, actions, about and shared chats. */
export function MemberProfile({
  actor: listed,
  onBack,
  standalone = false,
}: {
  actor: ActorSummary;
  onBack(): void;
  /** Mobile full-screen page with its own back button. */
  standalone?: boolean;
}) {
  const { t } = useTranslation();
  const { api, user, store, navigate } = useMessenger();
  const people = useAwayLookup();
  const actor = withCurrentAway(listed, people.overrides);
  const now = useAwayNow([actor.away]);
  const locale = calendarLocale();
  const status = shownStatus(actor, now, locale);
  const presence = useStore(
    store,
    (state) => state.presence[actor.actor_id] ?? "offline",
  );
  const { shared, loading } = useSharedChats(actor.actor_id);
  const [opening, setOpening] = useState(false);
  const [editingOrg, setEditingOrg] = useState(false);
  const isAgent = actor.type === "agent";
  const orgAvailable = useOrgAvailable();
  const org = useOrgStructure(api, !isAgent);
  const structure = orgAvailable && !isAgent ? (org.data ?? null) : null;
  const position = structure
    ? personOrg(structure, actor.actor_id).position
    : null;
  // The caption (`title`) stays under the name unless it repeats the
  // position (decision 3).
  const caption =
    actor.title &&
    (!position || foldOrgText(actor.title) !== foldOrgText(position.name))
      ? actor.title
      : "";

  async function write() {
    if (opening) return;
    setOpening(true);
    try {
      navigate(`/chat/${await openDirectChat(api, store, actor.actor_id)}`);
    } finally {
      setOpening(false);
    }
  }

  return (
    <div className="member-profile">
      {standalone && (
        <DirectoryDetailHead onBack={onBack} title={t("memberProfileTitle")} />
      )}
      <div className="member-profile__scroll">
        <header className="member-profile__identity">
          <AwayAvatar
            away={actor.away}
            now={now}
            name={actor.display_name}
            seed={actor.actor_id}
            actorID={actor.actor_id}
            avatarVersion={actor.avatar_version}
            size="xxl"
            agent={isAgent}
            square={isAgent}
            presence={isAgent ? undefined : presence}
          />
          <div className="member-profile__copy">
            <div className="member-profile__name">
              <h2>{actor.display_name}</h2>
              {isAgent && (
                <Tag tone="agent" size="lg">
                  {t("memberTagAgent")}
                </Tag>
              )}
            </div>
            <p className="member-profile__handle">
              {[
                `@${actor.handle}`,
                caption,
                !isAgent &&
                  t(
                    presence === "online"
                      ? "presenceOnline"
                      : presence === "away"
                        ? "presenceAway"
                        : "presenceOffline",
                  ),
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
            {status && status.text && (
              <span
                className={cx(
                  "member-profile__status",
                  status.away && "member-profile__status--away",
                )}
              >
                {status.emoji && (
                  <span aria-hidden="true">{status.emoji}</span>
                )}
                {status.text}
              </span>
            )}
            <div className="member-profile__actions">
              <Button
                variant="primary"
                size="md"
                pending={opening}
                onClick={() => void write()}
              >
                <MessageSquare aria-hidden="true" />
                {t("memberWrite")}
              </Button>
              {structure && canManageOrg(user) && (
                <Button size="md" onClick={() => setEditingOrg(true)}>
                  <Network aria-hidden="true" />
                  {t("orgEditPerson")}
                </Button>
              )}
            </div>
          </div>
        </header>
        <div className="member-profile__cards">
          {!isAgent && people.on && (
            <PersonAwayCard
              actor={actor}
              now={now}
              lookup={people.lookup}
            />
          )}
          {structure && (
            <PersonOrgCard actorID={actor.actor_id} structure={structure} />
          )}
          {actor.about && (
            <section className="member-profile__card">
              <h3>{t("memberAbout")}</h3>
              <p>{actor.about}</p>
            </section>
          )}
          <section className="member-profile__card member-profile__card--wide">
            <h3>
              {loading
                ? t("memberSharedChats")
                : t("memberSharedChatsCount", { count: shared.length })}
            </h3>
            {shared.length > 0 ? (
              <div className="member-profile__chats">
                {shared.map((chat) => (
                  <button
                    key={chat.id}
                    type="button"
                    className="member-profile__chat"
                    onClick={() => navigate(`/chat/${chat.id}`)}
                  >
                    <Avatar
                      name={titleOf(chat, [], user.id)}
                      seed={chat.avatar_seed}
                      {...chatAvatarSource(chat)}
                      size="xs"
                    />
                    <span>{titleOf(chat, [], user.id)}</span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="member-profile__muted">
                {loading
                  ? t("memberSharedChatsLoading")
                  : t("memberSharedChatsEmpty")}
              </p>
            )}
          </section>
        </div>
      </div>
      {editingOrg && structure && (
        <PersonOrgDialog
          api={api}
          actorID={actor.actor_id}
          name={actor.display_name}
          structure={structure}
          onClose={() => setEditingOrg(false)}
        />
      )}
    </div>
  );
}

/** How many reports show before "All". */
const subordinatesPreview = 4;

/**
 * The org group of a person card (prototype tab C): position, primary
 * department with its path, additional ones with "also", the manager and
 * reports — all links up and down the structure.
 */
function PersonOrgCard({
  actorID,
  structure,
}: {
  actorID: string;
  structure: OrgStructure;
}) {
  const { t } = useTranslation();
  const { api, navigate } = useMessenger();
  const everyone = useAllActors(api);
  const actors = useActorMap(everyone.data);
  const [allSubordinates, setAllSubordinates] = useState(false);
  const placed = personOrg(structure, actorID);
  const managerID = managerOf(structure, actorID);
  const manager = managerID ? actors.get(managerID) : undefined;
  const subordinates = subordinatesOf(structure, actorID)
    .map((id) => actors.get(id))
    .filter((item) => item !== undefined);
  if (
    !placed.position &&
    !placed.primary &&
    !manager &&
    !subordinates.length
  )
    return null;
  const shown = allSubordinates
    ? subordinates
    : subordinates.slice(0, subordinatesPreview);
  const departmentCaption = (id: string, primary: boolean) => {
    const path = departmentPath(structure, id, { includeSelf: false });
    return [
      primary ? t("orgDepartmentCaption") : t("orgAdditionalCaption"),
      path,
    ]
      .filter(Boolean)
      .join(" · ");
  };
  return (
    <>
      <section className="member-profile__card">
        <h3>{t("orgSection")}</h3>
        {placed.position && (
          <p className="org-card__position">
            <span>{t("orgPosition")}</span>
            <strong>{placed.position.name}</strong>
          </p>
        )}
        <div className="org-card__list">
          {placed.primary && (
            <OrgDepartmentLink
              department={placed.primary}
              caption={departmentCaption(placed.primary.id, true)}
              mark={
                placed.leads.some((item) => item.id === placed.primary!.id) && (
                  <OrgMark kind="lead">{t("orgMarkLead")}</OrgMark>
                )
              }
              onClick={() => navigate(departmentPathOf(placed.primary!.id))}
            />
          )}
          {placed.additional.map((department) => (
            <OrgDepartmentLink
              key={department.id}
              department={department}
              caption={departmentCaption(department.id, false)}
              mark={
                <OrgMark kind="additional">{t("orgMarkAdditional")}</OrgMark>
              }
              onClick={() => navigate(departmentPathOf(department.id))}
            />
          ))}
          {manager && (
            <OrgPersonLink
              actor={manager}
              caption={t("orgManagerCaption")}
              onClick={() => navigate(`/members/${manager.actor_id}`)}
            />
          )}
        </div>
      </section>
      {subordinates.length > 0 && (
        <section className="member-profile__card">
          <h3>{t("orgSubordinates", { count: subordinates.length })}</h3>
          <div className="org-card__list">
            {shown.map((person) => (
              <OrgPersonLink
                key={person.actor_id}
                actor={person}
                caption={personOrgLine(person, structure)}
                onClick={() => navigate(`/members/${person.actor_id}`)}
              />
            ))}
          </div>
          {subordinates.length > subordinatesPreview && (
            <Button
              variant="ghost"
              size="sm"
              className="org-card__more"
              onClick={() => setAllSubordinates((value) => !value)}
            >
              {allSubordinates ? t("orgShowLess") : t("orgShowAll")}
            </Button>
          )}
        </section>
      )}
    </>
  );
}

/**
 * "Away" of a person card (decision 5 and 14): the period, in effect
 * or planned ("20–30 November — on vacation"), and the substitute with
 * "Write".
 */
function PersonAwayCard({
  actor,
  now,
  lookup,
}: {
  actor: ActorSummary;
  now: Date;
  lookup: ReturnType<typeof useAwayLookup>["lookup"];
}) {
  const { t } = useTranslation();
  const { api, store, navigate } = useMessenger();
  const [opening, setOpening] = useState(false);
  const away = actor.away;
  if (!away || (!isAwayActive(away, now) && !isAwayPlanned(away, now)))
    return null;
  const locale = calendarLocale();
  const substitute = visibleSubstitute(away, lookup, now);
  async function write(actorID: string) {
    if (opening) return;
    setOpening(true);
    try {
      navigate(`/chat/${await openDirectChat(api, store, actorID)}`);
    } finally {
      setOpening(false);
    }
  }
  return (
    <section className="member-profile__card away-card">
      <h3>{t("memberAwayTitle")}</h3>
      <p className="away-card__line">
        <span aria-hidden="true">{awayKindEmoji[away.kind]}</span>
        {capitalize(awayLine(away, now, locale))}
      </p>
      {substitute && (
        <div className="away-card__substitute">
          <OrgPersonLink
            actor={substitute}
            caption={t("memberAwaySubstitute")}
            onClick={() => navigate(`/members/${substitute.actor_id}`)}
          />
          <Button
            size="sm"
            pending={opening}
            onClick={() => void write(substitute.actor_id)}
          >
            <MessageSquare aria-hidden="true" />
            {t("memberAwayWrite")}
          </Button>
        </div>
      )}
    </section>
  );
}
