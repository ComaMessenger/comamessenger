import type { useTranslation } from "react-i18next";

export type Translate = ReturnType<typeof useTranslation>["t"];

/* Formatting of agent runs lives in Core, shared with the phone. */
export {
  agentRunErrorText,
  chatName,
  formatCost,
  formatDateTime,
  formatDuration,
  formatTime,
  toolLabel,
  userTimezone,
} from "@comamessenger/core";
