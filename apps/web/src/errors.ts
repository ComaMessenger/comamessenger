import { APIError } from "@comamessenger/core";
import i18n from "./i18n";

export function messageOf(cause: unknown): string {
  if (cause instanceof APIError) {
    if (cause.status === 401) return i18n.t("errorUnauthorized");
    if (cause.status === 403) return i18n.t("errorForbidden");
    if (cause.status === 409) return i18n.t("errorConflict");
    if (cause.status === 422) return i18n.t("errorValidation");
    return i18n.t("error");
  }
  return cause instanceof Error ? cause.message : i18n.t("errorNetwork");
}
