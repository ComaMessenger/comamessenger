import { useQuery } from "@tanstack/react-query";
import type { MessengerAPI, ObjectLink } from "@comamessenger/core";
import { useSession } from "@/session/SessionProvider";
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
  });
  return api && query.data && fileID
    ? toSource(api, query.data, `file:${fileID}`)
    : null;
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
    retry: false,
  });
  return enabled && query.data
    ? toSource(api!, query.data, `avatar:${actorID}:${version}`)
    : null;
}
