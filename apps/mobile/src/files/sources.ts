import { useQuery } from "@tanstack/react-query";
import type { MessengerAPI, ObjectLink } from "@comamessenger/core";
import { useSession } from "@/session/SessionProvider";
import { isNetworkError } from "@/lib/errors";
import { absoluteURL } from "./auth";

export type ImageSource = {
  uri: string;
  headers?: Record<string, string>;
  cacheKey: string;
};

export function toSource(
  api: MessengerAPI,
  link: ObjectLink,
  cacheKey: string,
): ImageSource {
  return {
    uri: absoluteURL(api, link.url),
    headers: link.authenticated
      ? { Authorization: `Bearer ${api.token()}` }
      : undefined,
    cacheKey,
  };
}

/**
 * Without a link (offline) the image cache still has the bytes under the
 * same key; the placeholder URL is never fetched when the key is cached.
 */
function offlineSource(api: MessengerAPI, cacheKey: string): ImageSource {
  return {
    uri: `${api.apiURL}/api/v1/offline/${encodeURIComponent(cacheKey)}`,
    cacheKey,
  };
}

// Offline the cached bytes should appear at once, not after a retry.
const retryUnlessOffline = (failures: number, error: unknown) =>
  failures < 1 && !isNetworkError(error);

// Presigned links live for minutes; the image cache is keyed by object and
// version, so a fresh link never downloads the same bytes twice.
const linkStaleMs = 4 * 60_000;

/** Image source for a stored file (attachment or its preview). */
export function useFileSource(fileID: string | undefined): ImageSource | null {
  const { api } = useSession();
  const query = useQuery({
    queryKey: ["file-link", fileID],
    queryFn: () => api!.fileLink(fileID!),
    enabled: Boolean(api && fileID),
    staleTime: linkStaleMs,
    retry: retryUnlessOffline,
  });
  if (!api || !fileID) return null;
  if (query.data) return toSource(api, query.data, `file:${fileID}`);
  return query.isError ? offlineSource(api, `file:${fileID}`) : null;
}

/** Avatar image of an actor; null while the actor has no avatar. */
export function useAvatarSource(
  actorID: string | undefined,
  version: number | undefined,
): ImageSource | null {
  const { api } = useSession();
  const enabled = Boolean(api && actorID && version && version > 0);
  const query = useQuery({
    queryKey: ["avatar-link", actorID, version],
    queryFn: () => api!.avatarLink(actorID!),
    enabled,
    staleTime: linkStaleMs,
    retry: retryUnlessOffline,
  });
  if (!enabled) return null;
  const cacheKey = `avatar:${actorID}:${version}`;
  if (query.data) return toSource(api!, query.data, cacheKey);
  return query.isError ? offlineSource(api!, cacheKey) : null;
}
