import { serverFeature } from "@comamessenger/core";

/**
 * The server features «Важные» counts on the phone: requests and reminders.
 * Tasks (wave 3) and polls (wave 4) have no phone screens yet, so their
 * counts stay out of the «Ждут вас» chip and the tab badge until they come.
 */
export function phoneInboxFeatures(
  features: readonly string[] | null | undefined,
): string[] {
  return (features ?? []).filter(
    (feature) =>
      feature === serverFeature.requests || feature === serverFeature.reminders,
  );
}
