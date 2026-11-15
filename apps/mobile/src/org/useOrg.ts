import { useCallback, useEffect, useMemo } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useStore } from "zustand";
import {
  canManageOrg,
  fetchOrgStructure,
  orgIndex,
  orgKeys,
  orgStructureAvailable,
  uniquePeople,
  type ActorSummary,
  type OrgStructure,
} from "@comamessenger/core";
import { useMessenger } from "@/messenger/MessengerProvider";
import { useSignedIn } from "@/session/SessionProvider";
import { directoryKey } from "@/people/usePeople";

/**
 * The org structure of the workspace (phase 6.5 wave 2), read with ETag:
 * GET /org answers 304 while the cached version is current, so screens
 * read it again on every mount («Люди», the tree, settings) at no cost.
 * Without org_structure in hello the server has no structure: everything
 * of wave 2 stays hidden.
 */
export function useOrg() {
  const { api, user } = useSignedIn();
  const { store } = useMessenger();
  const queryClient = useQueryClient();
  const features = useStore(store, (state) => state.features);
  const available = orgStructureAvailable(features);
  const query = useQuery({
    queryKey: orgKeys.all,
    queryFn: () =>
      fetchOrgStructure(
        api,
        queryClient.getQueryData<OrgStructure>(orgKeys.all) ?? null,
      ),
    enabled: available,
    staleTime: 10_000,
  });
  const structure = available ? (query.data ?? null) : null;
  const order = useMemo(
    () => (structure ? orgIndex(structure).order : []),
    [structure],
  );
  return {
    available,
    features,
    structure,
    /** Every department in tree order. */
    order,
    /** org.manage or members.manage. */
    canManage: available && canManageOrg(user),
    loading: available && query.isPending,
    failed: available && query.isError && !query.data,
    refetch: () => void query.refetch(),
    /** For SettingsScreen's loading and error states. */
    query,
  };
}

/** After a write: read the structure again (304 when nothing changed). */
export function useOrgRefresh() {
  const queryClient = useQueryClient();
  return useCallback(
    () => queryClient.invalidateQueries({ queryKey: orgKeys.all }),
    [queryClient],
  );
}

/**
 * Every person and agent of the workspace: the grouped «Люди», pickers of
 * the org settings and the names in the tree need all of them, not the
 * first page. The directory pages keep loading until the end (a pilot is
 * 20–80 people).
 */
export function useAllPeople() {
  const { api } = useSignedIn();
  const pages = useInfiniteQuery({
    queryKey: directoryKey,
    queryFn: ({ pageParam }) => api.actors("", pageParam),
    initialPageParam: "",
    getNextPageParam: (page) => page.next_after_id ?? undefined,
    staleTime: 60_000,
  });
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = pages;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);
  const people = useMemo(
    () =>
      uniquePeople((pages.data?.pages ?? []).flatMap((page) => page.actors)),
    [pages.data],
  );
  const byID = useMemo(
    () => new Map(people.map((person) => [person.actor_id, person])),
    [people],
  );
  return {
    people,
    byID,
    loading: pages.isLoading || Boolean(hasNextPage),
    failed: pages.isError && people.length === 0,
    refetch: () => void pages.refetch(),
  };
}

/** One person from the loaded directory, for names in org rows. */
export function personName(
  byID: ReadonlyMap<string, ActorSummary>,
  actorID: string | null | undefined,
): string {
  return (actorID && byID.get(actorID)?.display_name) || "";
}
