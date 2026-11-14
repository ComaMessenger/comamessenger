import type { useTranslation } from "react-i18next";

/* Agent texts moved to packages/core (shared with the phone). */
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

export type Translate = ReturnType<typeof useTranslation>["t"];
