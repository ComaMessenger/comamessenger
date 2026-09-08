export type DirectoryKind = "threads" | "important" | "members";

/** `/threads`, `/threads/:id`, `/important/:id`, `/members/:id` → section + selected item. */
export function directoryFromPath(path: string): { kind: DirectoryKind; id?: string } | null {
  const match = /^\/(threads|important|members)(?:\/([^/]+))?\/?$/.exec(path);
  if (!match) return null;
  return { kind: match[1] as DirectoryKind, id: match[2] ? decodeURIComponent(match[2]) : undefined };
}
