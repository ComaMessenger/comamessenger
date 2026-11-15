import type { User } from "./types";

/**
 * The person's time zone. The server formats times in push texts («до пт,
 * 18:00») in `actors.timezone`; a profile still on the default `UTC` would
 * show them hours off. By the owner's decision the clients silently write the
 * device's zone over the default after sign-in, and never over a zone the
 * person chose.
 */

/** The zone a new profile gets: the person has not chosen one. */
export const defaultProfileTimezone = "UTC";

/** The device's IANA zone, or null when the engine does not tell. */
export function deviceTimezone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === "string" && zone.length > 0 ? zone : null;
  } catch {
    return null;
  }
}

/** True when the profile zone is the default one, not a choice. */
export function isDefaultTimezone(zone: string | null | undefined): boolean {
  return !zone || zone === defaultProfileTimezone || zone === "Etc/UTC";
}

/**
 * The zone to write to the profile, or null when nothing should change: the
 * profile has a chosen zone, the device does not know its zone, or it is UTC
 * itself.
 */
export function timezoneToSync(
  profile: string | null | undefined,
  device: string | null | undefined,
): string | null {
  if (!isDefaultTimezone(profile)) return null;
  if (!device || isDefaultTimezone(device)) return null;
  return device;
}

/**
 * Writes the device's zone to the profile when the profile has the default
 * one. Call it once after sign-in. Quiet: it never throws and returns the
 * updated profile, or null when nothing was written.
 */
export async function syncDeviceTimezone(
  api: {
    updateMe(input: Partial<Pick<User, "timezone">>): Promise<User>;
  },
  user: Pick<User, "timezone">,
  device: string | null = deviceTimezone(),
): Promise<User | null> {
  const zone = timezoneToSync(user.timezone, device);
  if (!zone) return null;
  try {
    return await api.updateMe({ timezone: zone });
  } catch {
    // The server may refuse a zone it does not know; the default stays and
    // the next sign-in tries again.
    return null;
  }
}
