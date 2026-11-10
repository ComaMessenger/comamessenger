import type { Chat } from "@comamessenger/core";
import type { useTranslation } from "react-i18next";

export type Translate = ReturnType<typeof useTranslation>["t"];

export function chatName(chat: Chat): string {
  return chat.name || chat.direct_peer?.display_name || chat.id;
}

/** Duration in the current UI language, never from the <html lang> guess. */
export function formatDuration(t: Translate, seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  if (seconds < 60)
    return t("agentDurationSeconds", {
      count: Math.max(1, Math.round(seconds)),
    });
  if (seconds < 3600)
    return t("agentDurationMinutes", { count: Math.round(seconds / 60) });
  return t("agentDurationHours", { count: Math.round(seconds / 3600) });
}

/** Money in the currency the server reported, formatted for the locale. */
export function formatCost(
  amount: string | number | null | undefined,
  currency: string | null | undefined,
  locale: string,
): string {
  const value = Number(amount ?? 0);
  const code = /^[A-Z]{3}$/.test(currency ?? "") ? currency! : "USD";
  const safe = Number.isFinite(value) ? value : 0;
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: code,
      maximumFractionDigits: safe > 0 && safe < 1 ? 4 : 2,
    }).format(safe);
  } catch {
    return `${safe} ${code}`;
  }
}

export function formatTime(value: string, locale: string): string {
  return new Date(value).toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDateTime(value: string, locale: string): string {
  const date = new Date(value);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay
    ? formatTime(value, locale)
    : date.toLocaleString(locale, {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
}

export function userTimezone(preferred?: string | null): string {
  return preferred || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

const knownRunErrors = new Set([
  "provider_credential_missing",
  "external_data_sharing_required",
  "external_data_sharing_not_approved",
  "budget_exceeded",
  "agent_provider_rate_limited",
  "provider_retryable",
  "provider_output_truncated",
  "tool_iteration_limit",
  "empty_provider_output",
  "run_timeout",
  "lease_expired",
  "run_canceled",
]);

export function agentRunErrorText(t: Translate, code: string): string {
  return knownRunErrors.has(code)
    ? t(`agentRunError_${code}`)
    : t("agentRunError_unknown");
}

/** Readable name of a tool, including external tools the client does not know. */
export function toolLabel(t: Translate, name: string): string {
  const key = `agentTool_${name}`;
  const known = t(key);
  if (known !== key) return known;
  const words = name.replace(/[_-]+/g, " ").trim();
  return t("agentToolExternal", { name: words || name });
}
