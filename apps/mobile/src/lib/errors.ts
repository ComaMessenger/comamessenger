import { APIError, apiErrorKey } from "@comamessenger/core";
import i18n from "@/i18n";

export function isNetworkError(cause: unknown): boolean {
  return !(cause instanceof APIError);
}

/** Human text of a failed request; the keys are shared with the web. */
export function messageOf(cause: unknown): string {
  return i18n.t(apiErrorKey(cause) ?? "errorNetwork");
}
