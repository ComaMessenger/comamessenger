import type { MessengerAPI } from "@comamessenger/core";
import { pickSquareImage, uploadImage } from "./images";

/** Avatars up to 10 MB, as the web checks. */
export const avatarMaxBytes = 10_000_000;

/**
 * Lets the user pick a square photo and uploads it as their avatar, or as a
 * workspace member's one when `actorID` is given (members.manage). Returns
 * false when the user cancelled.
 */
export async function pickAndUploadAvatar(
  api: MessengerAPI,
  actorID?: string,
): Promise<boolean> {
  const image = await pickSquareImage();
  if (!image) return false;
  await uploadImage(
    api,
    actorID
      ? `/api/v1/organization/members/${encodeURIComponent(actorID)}/avatar`
      : "/api/v1/me/avatar",
    image,
    avatarMaxBytes,
  );
  return true;
}
