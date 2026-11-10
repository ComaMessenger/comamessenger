import { parseInviteDeepLink, pendingInvite } from "@/lib/inviteLinks";

// Invitation links carry a server address, so they are handed to the session
// instead of being routed; the router lands on the screen the session allows.
export function redirectSystemPath({
  path,
}: {
  path: string;
  initial: boolean;
}) {
  const invite = parseInviteDeepLink(path);
  if (!invite) return path;
  pendingInvite.set(invite);
  return "/";
}
