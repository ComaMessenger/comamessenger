import type { QueryClient } from "@tanstack/react-query";

/**
 * Request caches belong to one signed-in person. The query client outlives
 * sign-out (it is created once in main.tsx), so it is emptied on sign-out and
 * whenever a different person signs in: the next person must never see the
 * previous one's saved messages, members or drafts, not even for a frame.
 * Returns the id that now owns the cache.
 */
export function claimSessionCache(
  queryClient: QueryClient,
  owner: string | null,
  next: string | null,
): string | null {
  if (owner !== next) queryClient.clear();
  return next;
}
