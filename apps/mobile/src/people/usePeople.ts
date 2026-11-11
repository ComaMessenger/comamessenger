import { useCallback, useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useStore } from "zustand";
import {
  filterPeople,
  sortPeople,
  uniquePeople,
  type ActorSummary,
  type MessengerAPI,
  type PeopleFilter,
} from "@comamessenger/core";
import { useMessenger } from "@/messenger/MessengerProvider";
import { useSignedIn } from "@/session/SessionProvider";

export const directoryKey = ["actors", "directory"] as const;

/**
 * People and agents of the workspace for the directory and the pickers.
 * Pages of the directory load as the list scrolls; a typed query also asks
 * the server, which searches the whole workspace, not only loaded pages.
 */
export function usePeople({
  query,
  filter = "all",
  exclude = [],
  locale,
}: {
  query: string;
  filter?: PeopleFilter;
  /** Hidden ids besides the reader: chosen people, current members. */
  exclude?: readonly string[];
  locale?: string;
}) {
  const { api, user } = useSignedIn();
  const { store } = useMessenger();
  const presence = useStore(store, (state) => state.presence);
  const needle = query.trim();
  const [debounced, setDebounced] = useState(needle);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(needle), 200);
    return () => clearTimeout(timer);
  }, [needle]);

  const pages = useInfiniteQuery({
    queryKey: directoryKey,
    queryFn: ({ pageParam }) => api.actors("", pageParam),
    initialPageParam: "",
    getNextPageParam: (page) => page.next_after_id ?? undefined,
    staleTime: 60_000,
  });
  const found = useQuery({
    queryKey: ["actors", "search", debounced],
    queryFn: () => api.actors(debounced),
    enabled: debounced.length > 0,
    staleTime: 30_000,
  });

  const loaded = useMemo(
    () =>
      uniquePeople((pages.data?.pages ?? []).flatMap((page) => page.actors)),
    [pages.data],
  );
  const hidden = useMemo(() => [user.id, ...exclude], [exclude, user.id]);
  const people = useMemo(() => {
    const local = filterPeople(loaded, {
      query: needle,
      filter,
      presence,
      exclude: hidden,
    });
    // Server matches the query its own way; keep them even if the local
    // match disagrees, filtered only by kind.
    const remote =
      needle && debounced === needle
        ? filterPeople(found.data?.actors ?? [], {
            filter,
            presence,
            exclude: hidden,
          })
        : [];
    return sortPeople(uniquePeople([...local, ...remote]), presence, locale);
  }, [debounced, filter, found.data, hidden, loaded, locale, needle, presence]);

  const counts = useMemo(() => {
    const others = loaded.filter((actor) => actor.actor_id !== user.id);
    const humans = others.filter((actor) => actor.type === "user");
    return {
      humans: humans.length,
      agents: others.length - humans.length,
      online: humans.filter((actor) => presence[actor.actor_id] === "online")
        .length,
    };
  }, [loaded, presence, user.id]);

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = pages;
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  return {
    people,
    presence,
    counts,
    loading: pages.isLoading,
    searching: Boolean(needle) && (found.isFetching || debounced !== needle),
    failed: pages.isError && loaded.length === 0,
    refetch: () => void pages.refetch(),
    loadMore,
    loadingMore: isFetchingNextPage,
    complete: !hasNextPage,
  };
}

/**
 * One actor by id. The directory has no single-actor endpoint, so this looks
 * in the loaded pages first and then pages through, as the web does.
 */
export async function findActor(
  api: MessengerAPI,
  actorID: string,
  known: readonly ActorSummary[],
): Promise<ActorSummary | null> {
  const cached = known.find((actor) => actor.actor_id === actorID);
  if (cached) return cached;
  let after = "";
  for (let page = 0; page < 20; page += 1) {
    const result = await api.actors("", after);
    const match = result.actors.find((actor) => actor.actor_id === actorID);
    if (match) return match;
    if (!result.next_after_id) break;
    after = result.next_after_id;
  }
  return null;
}
