import type { QueryClient } from "@tanstack/react-query";
import {
  orgEventEffect,
  orgKeys,
  type DurableEvent,
  type OrgStructure,
} from "@comamessenger/core";

let orgTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * org.updated carries only the version: when it is newer than the cached
 * structure, read GET /org once after a short pause (a burst of writes is
 * one read). True when the event was org.updated.
 */
export function applyOrgEvent(
  queryClient: QueryClient,
  event: Pick<DurableEvent, "type" | "data">,
): boolean {
  const cached = queryClient.getQueryData<OrgStructure>(orgKeys.all);
  const effect = orgEventEffect(event, cached?.version);
  if (!effect) return false;
  if (effect.kind === "refetch" && orgTimer === null)
    orgTimer = setTimeout(() => {
      orgTimer = null;
      void queryClient.invalidateQueries({ queryKey: orgKeys.all });
      // Search by position and department lives in the directory too.
      void queryClient.invalidateQueries({ queryKey: ["actors"] });
    }, effect.delayMs);
  return true;
}
