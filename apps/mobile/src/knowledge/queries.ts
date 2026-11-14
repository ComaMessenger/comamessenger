import { useQuery } from "@tanstack/react-query";
import {
  isProcessing,
  knowledgeCollectionKey,
  knowledgeCollectionsKey,
  knowledgeDocumentKey,
  knowledgeDocumentsKey,
  type KnowledgeCollection,
} from "@comamessenger/core";
import { useQueryClient } from "@tanstack/react-query";
import { cacheStorage } from "@/lib/database";
import { isNetworkError } from "@/lib/errors";
import { useSignedIn } from "@/session/SessionProvider";

const cacheKey = (key: readonly unknown[]) => `kb:${key.join(":")}`;

/**
 * A knowledge request that keeps its last answer on the phone: offline the
 * screen shows the saved copy (and says so) instead of an error. Server
 * errors (not found, no access) are never hidden by an old copy.
 */
function useKnowledgeQuery<T>(
  key: readonly unknown[],
  fetch: () => Promise<T>,
  options: {
    enabled?: boolean;
    refetchInterval?: (data: T | undefined) => number | false;
    initialData?: () => T | undefined;
  } = {},
) {
  const live = useQuery({
    queryKey: key,
    queryFn: async () => {
      const value = await fetch();
      void cacheStorage.set(cacheKey(key), value).catch(() => undefined);
      return value;
    },
    enabled: options.enabled ?? true,
    retry: (failures, error) => failures < 1 && isNetworkError(error),
    refetchInterval: options.refetchInterval
      ? (query) => options.refetchInterval!(query.state.data)
      : undefined,
    initialData: options.initialData,
  });
  const offline = live.isError && isNetworkError(live.error);
  const saved = useQuery({
    queryKey: ["knowledge-saved", ...key],
    queryFn: () => cacheStorage.get<T>(cacheKey(key)),
    enabled: offline,
    staleTime: Infinity,
  });
  const copy = offline && live.data === undefined ? saved.data : undefined;
  return {
    data: live.data ?? copy ?? undefined,
    /** The data is the saved copy: no connection right now. */
    offline: offline && Boolean(copy ?? live.data),
    isPending: live.isPending && !live.isError,
    isError: live.isError && !(copy ?? live.data),
    isFetching: live.isFetching,
    error: live.error,
    refetch: live.refetch,
    /** Still looking for a saved copy after an offline failure. */
    lookingForCopy: offline && saved.isPending,
  };
}

export type KnowledgeQuery<T> = ReturnType<typeof useKnowledgeQuery<T>>;

export function useCollections() {
  const { api } = useSignedIn();
  return useKnowledgeQuery(knowledgeCollectionsKey, () =>
    api.knowledgeCollections(),
  );
}

export function useCollection(collectionID: string) {
  const { api } = useSignedIn();
  const client = useQueryClient();
  return useKnowledgeQuery(
    knowledgeCollectionKey(collectionID),
    () => api.knowledgeCollection(collectionID),
    {
      initialData: () =>
        client
          .getQueryData<KnowledgeCollection[]>(knowledgeCollectionsKey)
          ?.find((item) => item.id === collectionID),
    },
  );
}

export function useDocuments(collectionID: string, enabled: boolean) {
  const { api } = useSignedIn();
  return useKnowledgeQuery(
    knowledgeDocumentsKey(collectionID),
    () => api.knowledgeDocuments(collectionID),
    {
      enabled,
      // Indexing is asynchronous; poll while anything is queued or processing.
      refetchInterval: (data) => (data?.some(isProcessing) ? 2_000 : false),
    },
  );
}

export function useDocument(documentID: string) {
  const { api } = useSignedIn();
  return useKnowledgeQuery(
    knowledgeDocumentKey(documentID),
    () => api.knowledgeDocument(documentID),
    {
      refetchInterval: (data) => (data && isProcessing(data) ? 2_000 : false),
    },
  );
}

export function useFragments(
  documentID: string,
  version: string,
  enabled: boolean,
) {
  const { api } = useSignedIn();
  return useKnowledgeQuery(
    [...knowledgeDocumentKey(documentID), "fragments", version],
    () => api.knowledgeDocumentFragments(documentID),
    { enabled },
  );
}

/** After a document was added, changed or removed. */
export function useInvalidateCollection() {
  const client = useQueryClient();
  return (collectionID: string) =>
    Promise.all([
      client.invalidateQueries({
        queryKey: knowledgeDocumentsKey(collectionID),
      }),
      client.invalidateQueries({
        queryKey: knowledgeCollectionKey(collectionID),
      }),
      client.invalidateQueries({ queryKey: knowledgeCollectionsKey }),
    ]);
}
