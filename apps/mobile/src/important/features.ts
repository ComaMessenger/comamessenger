import { serverFeature } from "@comamessenger/core";

/**
 * The server features «Важные» counts on the phone: requests, reminders,
 * tasks and polls (wave 4: polls with a due date wait in «Ждут вас», the
 * «Опросы» chip, the hot ones count in the tab badge).
 */
export function phoneInboxFeatures(
  features: readonly string[] | null | undefined,
): string[] {
  return (features ?? []).filter(
    (feature) =>
      feature === serverFeature.requests ||
      feature === serverFeature.reminders ||
      feature === serverFeature.tasks ||
      feature === serverFeature.polls,
  );
}
