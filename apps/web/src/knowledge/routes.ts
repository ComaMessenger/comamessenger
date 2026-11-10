export type KnowledgeRoute = {
  collectionID?: string;
  documentID?: string;
};

/** `/knowledge`, `/knowledge/:collection`, `/knowledge/:collection/:document`. */
export function knowledgeFromPath(path: string): KnowledgeRoute | null {
  const match = /^\/knowledge(?:\/([^/]+))?(?:\/([^/]+))?\/?$/.exec(path);
  if (!match) return null;
  return {
    collectionID: match[1] ? decodeURIComponent(match[1]) : undefined,
    documentID: match[2] ? decodeURIComponent(match[2]) : undefined,
  };
}

export function knowledgePath(
  collectionID?: string,
  documentID?: string,
  focus?: { fragment?: string; query?: string; quote?: string },
) {
  let path = "/knowledge";
  if (collectionID) path += `/${encodeURIComponent(collectionID)}`;
  if (collectionID && documentID) path += `/${encodeURIComponent(documentID)}`;
  const search = new URLSearchParams();
  if (focus?.fragment) search.set("fragment", focus.fragment);
  if (focus?.query) search.set("q", focus.query);
  if (focus?.quote) search.set("quote", focus.quote);
  return search.size ? `${path}?${search}` : path;
}
