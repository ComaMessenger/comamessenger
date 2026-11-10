import type { Chat } from "@comamessenger/core";
import type { useTranslation } from "react-i18next";

export type Translate = ReturnType<typeof useTranslation>["t"];

export function chatName(chat: Chat): string {
  return chat.name || chat.direct_peer?.display_name || chat.id;
}

export function formatProductDuration(seconds: number): string {
  if (!seconds) return "—";
  const russian = document.documentElement.lang === "ru";
  if (seconds < 60) return `${Math.round(seconds)} ${russian ? "с" : "s"}`;
  if (seconds < 3600)
    return `${Math.round(seconds / 60)} ${russian ? "мин" : "min"}`;
  return `${Math.round(seconds / 3600)} ${russian ? "ч" : "h"}`;
}

export function agentRunErrorText(t: Translate, code: string): string {
  const known = new Set([
    "provider_credential_missing",
    "external_data_sharing_required",
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
  return known.has(code)
    ? t(`agentRunError_${code}`)
    : t("agentRunError_unknown");
}
