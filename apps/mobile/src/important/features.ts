import { serverFeature } from "@comamessenger/core";

/**
 * The server features «Важные» counts on the phone: requests, reminders and
 * tasks. Polls (wave 4) have no phone screens yet, so their counts and the
 * «Опросы» chip stay out of «Ждут вас» and the tab badge until they come.
 */
export function phoneInboxFeatures(
  features: readonly string[] | null | undefined,
): string[] {
  return (features ?? []).filter(
    (feature) =>
      feature === serverFeature.requests ||
      feature === serverFeature.reminders ||
      feature === serverFeature.tasks,
  );
}
