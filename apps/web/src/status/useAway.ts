import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useStore } from "zustand";
import {
  awayAvailable,
  awayErrorKind,
  awayKeys,
  currentAway,
  nextAwayChange,
  withCurrentAway,
  type ActorSummary,
  type AwayDraftProblem,
  type AwayErrorKind,
  type AwayPerson,
  type AwayPublic,
} from "@comamessenger/core";
import i18n from "../i18n";
import { MessengerContext, useMessenger } from "../shell/MessengerContext";
import { useAllActors } from "../org/useOrg";

/** The server announced "Away" (`actor_away`). */
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
 * (and at least every minute), so "on vacation until …" goes away by itself.
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
      Math.min(60_000, Number.isFinite(next) ? next - Date.now() + 500 : 60_000),
    );
    const timer = setTimeout(() => setNow(new Date()), wait);
    return () => clearTimeout(timer);
  }, [next, now]);
  return now;
}

/**
 * People of the workspace by id with their freshest away status, to find
 * a substitute who may not be in the chat. Reads the directory only on
 * servers with actor_away.
 */
const noLookup = {
  on: false,
  overrides: {},
  lookup: () => null,
  loaded: false,
} as const;

export function useAwayLookup(): {
  on: boolean;
  overrides: Readonly<Record<string, AwayPublic | null>>;
  lookup(actorID: string): (ActorSummary & AwayPerson) | null;
  loaded: boolean;
} {
  // Pickers are also drawn alone (tests, the component catalog): without
  // the messenger there is nobody to look up. The context never comes and
  // goes under a mounted component, so the hooks below keep their order.
  const context = useContext(MessengerContext);
  if (!context) return noLookup;
  return useLiveAwayLookup();
}

function useLiveAwayLookup() {
  const { api } = useMessenger();
  const on = useAwayAvailable();
  const overrides = useAwayOverrides();
  const everyone = useAllActors(api, on);
  const byID = useMemo(
    () =>
      new Map(
        (everyone.data ?? []).map((actor) => [actor.actor_id, actor] as const),
      ),
    [everyone.data],
  );
  const lookup = useCallback(
    (actorID: string): (ActorSummary & AwayPerson) | null => {
      const actor = byID.get(actorID);
      return actor ? withCurrentAway(actor, overrides) : null;
    },
    [byID, overrides],
  );
  return { on, overrides, lookup, loaded: Boolean(everyone.data) };
}

/** The person's own away status with the private settings (getAway). */
export function useMyAway(enabled = true) {
  const { api, user } = useMessenger();
  const on = useAwayAvailable();
  return useQuery({
    queryKey: awayKeys.mine(user.id),
    enabled: on && enabled,
    queryFn: () => api.away(),
    staleTime: 30_000,
  });
}

/** Whom the reader substitutes for ("You substitute for …"). */
export function useSubstituting() {
  const { api, user } = useMessenger();
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
  const { user } = useMessenger();
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
export function awayErrorText(error: unknown): string {
  return i18n.t(failKeys[awayErrorKind(error)]);
}

/** Words for the first problem of the form. */
export function awayProblemText(problem: AwayDraftProblem): string {
  switch (problem.field) {
    case "label":
      return i18n.t(
        problem.reason === "empty"
          ? "awayErrorLabelEmpty"
          : "awayErrorLabelTooLong",
      );
    case "startsAt":
      return i18n.t("awayErrorStartTooFar");
    case "endsAt":
      return i18n.t(
        problem.reason === "empty"
          ? "awayErrorEndsEmpty"
          : problem.reason === "beforeStart"
            ? "awayErrorEndsBeforeStart"
            : "awayErrorEndsTooLong",
      );
    case "autoreply":
      return i18n.t(
        problem.reason === "empty"
          ? "awayErrorAutoreplyEmpty"
          : "awayErrorAutoreplyTooLong",
      );
    case "substitute":
      return i18n.t("awayErrorSubstituteSelf");
  }
}
