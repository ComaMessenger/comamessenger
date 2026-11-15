import type { ComponentProps } from "react";
import { avatarBadge, type AwayPublic } from "@comamessenger/core";
import { Avatar } from "../ui";

/**
 * An avatar whose presence dot gives way to the away kind (decision 9): 🌴
 * while on vacation, even when the person looked in. Without an away status
 * in effect it is the plain avatar with its presence.
 */
export function AwayAvatar({
  away,
  now = new Date(),
  presence,
  ...props
}: ComponentProps<typeof Avatar> & {
  away?: AwayPublic | null;
  now?: Date;
}) {
  const badge = avatarBadge(presence ?? null, away ?? null, now);
  return (
    <Avatar
      {...props}
      presence={presence}
      statusBadge={badge?.kind === "away" ? badge.emoji : undefined}
    />
  );
}
