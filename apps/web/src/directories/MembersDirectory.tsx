import { useMemo, useState } from "react";
import { Users } from "lucide-react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { hasPermission } from "../settings";
import { Avatar, Button, Chip, EmptyState, InlineError, SearchField, SkeletonRow, Tag } from "../ui";
import { useIsMobile, useIsNarrowDesktop } from "../lib/useMediaQuery";
import { useMessenger } from "../shell/MessengerContext";
import { DirectoryList, DirectoryRow, DirectorySplit } from "./DirectoryPage";
import { MemberProfile } from "./MemberProfile";

type Filter = "all" | "online" | "people" | "agents";

export function MembersDirectory({ selectedID }: { selectedID?: string }) {
  const { t } = useTranslation();
  const { api, user, store, navigate } = useMessenger();
  const isMobile = useIsMobile();
  const narrow = useIsNarrowDesktop();
  const presence = useStore(store, (state) => state.presence);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
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
  const needle = search.trim().toLocaleLowerCase();
  const visible = actors.filter((actor) => {
    if (filter === "online" && presence[actor.actor_id] !== "online") return false;
    if (filter === "people" && actor.type !== "user") return false;
    if (filter === "agents" && actor.type !== "agent") return false;
    if (!needle) return true;
    return [actor.display_name, actor.handle, actor.title]
      .some((value) => value.toLocaleLowerCase().includes(needle));
  });
  const activeID = selectedID ?? (!isMobile && !narrow ? visible[0]?.actor_id : undefined);
  const active = actors.find((actor) => actor.actor_id === activeID);
  const canInvite = hasPermission(user, "invitations.manage");

  const list = (
    <DirectoryList
      title={t("members")}
      lead={query.data ? t("membersLeadShort", { humans, agents }) : t("membersHint")}
      action={
        canInvite && (
          <Button size="sm" variant="primary" onClick={() => navigate("/settings/workspace/invitations")}>
            {t("membersInvite")}
          </Button>
        )
      }
      toolbar={
        <SearchField
          value={search}
          onChange={setSearch}
          placeholder={t("membersSearch")}
          clearLabel={t("clearSearch")}
        />
      }
      chips={
        query.data && (
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
        )
      }
    >
      {query.isLoading ? (
        <>
          <SkeletonRow avatar={40} lines={["40%", "60%"]} />
          <SkeletonRow avatar={40} lines={["50%", "45%"]} />
          <SkeletonRow avatar={40} lines={["35%", "70%"]} />
          <SkeletonRow avatar={40} lines={["45%", "55%"]} />
        </>
      ) : query.isError ? (
        <InlineError
          center
          title={t("threadsLoadFailed")}
          onRetry={() => void query.refetch()}
          retryLabel={t("retry")}
        />
      ) : visible.length === 0 ? (
        <EmptyState icon={<Users />} title={t("membersEmpty")} hint={t("membersEmptyHint")} />
      ) : (
        <>
          {visible.map((actor) => {
            const isAgent = actor.type === "agent";
            const state = presence[actor.actor_id] ?? "offline";
            return (
              <DirectoryRow
                key={actor.actor_id}
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
                    <span className="directory-member__name truncate">{actor.display_name}</span>
                    {isAgent && (
                      <Tag tone="agent" size="md">
                        {t("memberTagAgent")}
                      </Tag>
                    )}
                  </>
                }
                meta={
                  <span className="truncate">{actor.title || `@${actor.handle}`}</span>
                }
                trailing={
                  actor.status_emoji ? (
                    <span className="directory-member__emoji" title={actor.status_text || undefined}>
                      {actor.status_emoji}
                    </span>
                  ) : undefined
                }
                onClick={() => navigate(`/members/${actor.actor_id}`)}
              />
            );
          })}
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
      )}
    </DirectoryList>
  );

  if (isMobile) return list;
  return (
    <DirectorySplit
      list={list}
      detailOpen={Boolean(selectedID)}
      detail={
        active ? (
          <MemberProfile key={active.actor_id} actor={active} onBack={() => navigate("/members")} />
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
