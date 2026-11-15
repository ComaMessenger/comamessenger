export type DirectoryKind = "threads" | "important" | "members";

/**
 * `/threads`, `/threads/:id`, `/important/:id`, `/members/:id` → section +
 * selected item; `/members/departments/:id` → the members section with a
 * department card.
 */
export function directoryFromPath(
  path: string,
): { kind: DirectoryKind; id?: string; departmentID?: string } | null {
  const department = /^\/members\/departments\/([^/]+)\/?$/.exec(path);
  if (department)
    return {
      kind: "members",
      departmentID: decodeURIComponent(department[1]!),
    };
  const match = /^\/(threads|important|members)(?:\/([^/]+))?\/?$/.exec(path);
  if (!match) return null;
  return { kind: match[1] as DirectoryKind, id: match[2] ? decodeURIComponent(match[2]) : undefined };
}

export function departmentPathOf(departmentID: string) {
  return `/members/departments/${encodeURIComponent(departmentID)}`;
}
