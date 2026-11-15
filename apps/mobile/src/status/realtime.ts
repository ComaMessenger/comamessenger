import type { QueryClient } from "@tanstack/react-query";
import {
  awayKeys,
  isAwayEvent,
  parseAwayEvent,
  reduceSubstituting,
  type DurableEvent,
  type SubstitutingEntry,
} from "@comamessenger/core";

/**
 * «Отсутствую» after a realtime event. The store already keeps
 * actor.away.updated in its overrides (headers, slots, hints read them);
 * here the lists in TanStack Query follow: «Вы замещаете …», «Люди» with
 * their filters, and the own status (getMe and getAway) when it changed on
 * another device or started and ended by itself.
 */
export function applyAwayEvent(
  queryClient: QueryClient,
  userID: string,
  event: DurableEvent,
  refreshMe: () => void,
): void {
  if (!isAwayEvent(event.type)) return;
  const parsed = parseAwayEvent(event);
  const key = awayKeys.substituting(userID);
  const items = queryClient.getQueryData<SubstitutingEntry[]>(key);
  if (!parsed || !items) void queryClient.invalidateQueries({ queryKey: key });
  else {
    const next = reduceSubstituting(items, parsed);
    if (next.stale) void queryClient.invalidateQueries({ queryKey: key });
    else if (next.changed) queryClient.setQueryData(key, next.items);
  }
  if (event.type !== "actor.away.updated") return;
  // Who is here and who is away changed: the filtered lists read again.
  void queryClient.invalidateQueries({
    queryKey: awayKeys.people(userID, "away").slice(0, 3),
  });
  void queryClient.invalidateQueries({ queryKey: ["actors"] });
  if (parsed?.data.actor_id === userID) {
    void queryClient.invalidateQueries({ queryKey: awayKeys.mine(userID) });
    refreshMe();
  }
}
