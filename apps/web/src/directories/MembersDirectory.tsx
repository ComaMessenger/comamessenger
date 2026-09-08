import { useMemo, useState } from "react";
import { Users } from "lucide-react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import type { ActorSummary } from "@comamessenger/core";
import {
  Avatar,
  Button,
  EmptyState,
  InlineError,
  SearchField,
  SkeletonRow,
  Tag,
} from "../ui";
import { useMessenger } from "../shell/MessengerContext";
import { DirectoryPage, DirectoryRow } from "./DirectoryPage";
import { openDirectChat } from "./openDirectChat";

export function MembersDirectory() {
  const { t } = useTranslation();
  const { api, user, store, navigate } = useMessenger();
  const presence = useStore(store, (state) => state.presence);
  const [search, setSearch] = useState("");
  const [opening, setOpening] = useState<string | null>(null);
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
  const needle = search.trim().toLocaleLowerCase();
  const visible = needle
    ? actors.filter(
        (actor) =>
          actor.display_name.toLocaleLowerCase().includes(needle) ||
          actor.handle.toLocaleLowerCase().includes(needle),
      )
    : actors;

  async function open(actor: ActorSummary) {
    if (opening) return;
    setOpening(actor.actor_id);
    try {
      navigate(`/chat/${await openDirectChat(api, store, actor.actor_id)}`);
    } finally {
      setOpening(null);
    }
  }

  return (
    <DirectoryPage
      title={t("members")}
      lead={
        query.data ? t("membersLead", { humans, agents }) : t("membersHint")
      }
      onBack={() => navigate("/chats")}
      toolbar={
        <SearchField
          value={search}
          onChange={setSearch}
          placeholder={t("membersSearch")}
          clearLabel={t("clearSearch")}
        />
      }
    >
      {query.isLoading ? (
        <>
          <SkeletonRow avatar={44} lines={["40%", "60%"]} />
          <SkeletonRow avatar={44} lines={["50%", "45%"]} />
          <SkeletonRow avatar={44} lines={["35%", "70%"]} />
          <SkeletonRow avatar={44} lines={["45%", "55%"]} />
        </>
      ) : query.isError ? (
        <InlineError
          center
          title={t("threadsLoadFailed")}
          onRetry={() => void query.refetch()}
          retryLabel={t("retry")}
        />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={<Users />}
          title={t("membersEmpty")}
          hint={t("membersEmptyHint")}
        />
      ) : (
        <>
          {visible.map((actor) => {
            const isAgent = actor.type === "agent";
            const state = presence[actor.actor_id] ?? "offline";
            return (
              <DirectoryRow
                key={actor.actor_id}
                className="directory-row--member"
                label={t("openDirectChat", { name: actor.display_name })}
                disabled={opening === actor.actor_id}
                leading={
                  <Avatar
                    name={actor.display_name}
                    seed={actor.actor_id}
                    actorID={actor.actor_id}
                    avatarVersion={actor.avatar_version}
                    size="xl"
                    agent={isAgent}
                    square={isAgent}
                    presence={isAgent ? undefined : state}
                  />
                }
                title={
                  <>
                    <span className="directory-member__name">
                      {actor.display_name}
                    </span>
                    <span className="directory-member__handle">
                      @{actor.handle}
                    </span>
                  </>
                }
                meta={
                  <>
                    {actor.title && (
                      <span className="directory-member__title truncate">
                        {actor.title}
                      </span>
                    )}
                    {actor.status_text && (
                      <span className="directory-member__status">
                        {actor.status_emoji && `${actor.status_emoji} `}
                        {actor.status_text}
                      </span>
                    )}
                  </>
                }
                trailing={
                  <Tag tone={isAgent ? "agent" : "neutral"} size="lg">
                    {isAgent ? t("memberTagAgent") : t("memberTagUser")}
                  </Tag>
                }
                onClick={() => void open(actor)}
              />
            );
          })}
          {query.hasNextPage && !needle && (
            <div className="directory-page__more">
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
    </DirectoryPage>
  );
}
