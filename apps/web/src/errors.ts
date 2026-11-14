import { apiErrorKey } from "@comamessenger/core";
import i18n from "./i18n";

export function messageOf(cause: unknown): string {
  const key = apiErrorKey(cause);
  if (key) return i18n.t(key);
  return cause instanceof Error ? cause.message : i18n.t("errorNetwork");
}
