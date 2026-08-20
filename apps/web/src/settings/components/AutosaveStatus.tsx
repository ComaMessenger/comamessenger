import { useTranslation } from "react-i18next";
import { cx } from "../../ui";
import type { AutosavePhase } from "../hooks/useAutosave";

export function AutosaveStatus({
  phase,
  error,
  onRetry,
}: {
  phase: AutosavePhase;
  error: string;
  onRetry(): void;
}) {
  const { t } = useTranslation();
  if (phase === "idle") return null;
  return (
    <div
      className={cx("settings-autosave", phase === "error" && "error")}
      aria-live="polite"
    >
      {phase === "error" ? (
        <>
          <span>{error || t("autosaveError")}</span>
          <button onClick={onRetry}>{t("retry")}</button>
        </>
      ) : (
        <span>
          {phase === "saved" ? t("autosaveSaved") : t("autosaveSaving")}
        </span>
      )}
    </div>
  );
}
