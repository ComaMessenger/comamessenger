import { useCallback, useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useStore } from "zustand";
import {
  awayAvailable,
  awayErrorKind,
  awayKeys,
  currentAway,
  nextAwayChange,
  uniquePeople,
  withCurrentAway,
  type ActorSummary,
  type AwayDraftProblem,
  type AwayErrorKind,
  type AwayPerson,
  type AwayPublic,
} from "@comamessenger/core";
import { useMessenger } from "@/messenger/MessengerProvider";
import { directoryKey } from "@/people/usePeople";
import { useSignedIn } from "@/session/SessionProvider";

type Translate = (key: string, values?: Record<string, unknown>) => string;

/** The server announced «Отсутствую» (`actor_away`). */
export function useAwayAvailable(): boolean {
  const { store } = useMessenger();
  const features = useStore(store, (state) => state.features);
  return useMemo(() => awayAvailable(features), [features]);
}

/** actor.away.updated learnt during this session, fresher than REST. */
export function useAwayOverrides() {
  const { store } = useMessenger();
  return useStore(store, (state) => state.awayOverrides);
}

/**
 * The clock for away lines: re-renders when a status shown starts or ends
 * (and at least every minute), so «в отпуске до …» goes away by itself.
 */
export function useAwayNow(
  aways: readonly (AwayPublic | null | undefined)[] = [],
): Date {
  const [now, setNow] = useState(() => new Date());
  const next = aways
    .map((away) => nextAwayChange(away, now)?.getTime() ?? Infinity)
    .reduce((left, right) => Math.min(left, right), Infinity);
  useEffect(() => {
    const wait = Math.max(
      1_000,
      Math.min(
        60_000,
        Number.isFinite(next) ? next - Date.now() + 500 : 60_000,
      ),
    );
    const timer = setTimeout(() => setNow(new Date()), wait);
    return () => clearTimeout(timer);
  }, [next, now]);
  return now;
}

/**
 * Every person and agent of the workspace: a substitute may not be in the
 * chat, and «Вместо меня» picks among everyone. The directory pages keep
 * loading until the end (a pilot is 20–80 people); the cache is the one of
 * «Люди».
 */
export function useWorkspacePeople(enabled = true) {
  const { api } = useSignedIn();
  const pages = useInfiniteQuery({
    queryKey: directoryKey,
    queryFn: ({ pageParam }) => api.actors("", pageParam),
    initialPageParam: "",
    getNextPageParam: (page) => page.next_after_id ?? undefined,
    staleTime: 60_000,
    enabled,
  });
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = pages;
  useEffect(() => {
    if (enabled && hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [enabled, fetchNextPage, hasNextPage, isFetchingNextPage]);
  const people = useMemo(
    () =>
      uniquePeople((pages.data?.pages ?? []).flatMap((page) => page.actors)),
    [pages.data],
  );
  const byID = useMemo(
    () => new Map(people.map((person) => [person.actor_id, person] as const)),
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

/**
 * People of the workspace by id with their freshest away status, to find a
 * substitute who may not be in the chat. Reads the directory only on
 * servers with actor_away.
 */
export function useAwayLookup(): {
  on: boolean;
  overrides: Readonly<Record<string, AwayPublic | null>>;
  lookup(actorID: string): (ActorSummary & AwayPerson) | null;
  loaded: boolean;
} {
  const on = useAwayAvailable();
  const overrides = useAwayOverrides();
  const everyone = useWorkspacePeople(on);
  const lookup = useCallback(
    (actorID: string): (ActorSummary & AwayPerson) | null => {
      const actor = everyone.byID.get(actorID);
      return actor ? withCurrentAway(actor, overrides) : null;
    },
    [everyone.byID, overrides],
  );
  return { on, overrides, lookup, loaded: !everyone.loading };
}

/** The person's own away status with the private settings (getAway). */
export function useMyAway(enabled = true) {
  const { api, user } = useSignedIn();
  const on = useAwayAvailable();
  return useQuery({
    queryKey: awayKeys.mine(user.id),
    enabled: on && enabled,
    queryFn: () => api.away(),
    staleTime: 30_000,
  });
}

/** Whom the reader substitutes for («Вы замещаете …»). */
export function useSubstituting() {
  const { api, user } = useSignedIn();
  const on = useAwayAvailable();
  return useQuery({
    queryKey: awayKeys.substituting(user.id),
    enabled: on,
    queryFn: () => api.substituting(),
    staleTime: 60_000,
  });
}

/** The reader's own public away status: an event first, then getMe. */
export function useSelfAway(): AwayPublic | null {
  const { user } = useSignedIn();
  const overrides = useAwayOverrides();
  return currentAway(user.id, user.away ?? null, overrides);
}

const failKeys: Record<AwayErrorKind, string> = {
  invalid: "awayFailInvalid",
  substituteInvalid: "awayFailSubstituteInvalid",
  conflict: "awayFailConflict",
  forbidden: "awayFailForbidden",
  rateLimited: "awayFailRateLimited",
  unavailable: "awayFailUnavailable",
  network: "awayFailNetwork",
  other: "awayFailOther",
};

/** Words for a refused away call. */
export function awayErrorText(t: Translate, error: unknown): string {
  return t(failKeys[awayErrorKind(error)]);
}

/** Words for the first problem of the form. */
export function awayProblemText(
  t: Translate,
  problem: AwayDraftProblem,
): string {
  switch (problem.field) {
    case "label":
      return t(
        problem.reason === "empty"
          ? "awayErrorLabelEmpty"
          : "awayErrorLabelTooLong",
      );
    case "startsAt":
      return t("awayErrorStartTooFar");
    case "endsAt":
      return t(
        problem.reason === "empty"
          ? "awayErrorEndsEmpty"
          : problem.reason === "beforeStart"
            ? "awayErrorEndsBeforeStart"
            : "awayErrorEndsTooLong",
      );
    case "autoreply":
      return t(
        problem.reason === "empty"
          ? "awayErrorAutoreplyEmpty"
          : "awayErrorAutoreplyTooLong",
      );
    case "substitute":
      return t("awayErrorSubstituteSelf");
  }
}
