import { humanStatusLabel } from "@comamessenger/core";
import { useTranslation } from "react-i18next";
import { cx } from "../../ui";
import { statusTone, type HumanStatus } from "./status";

/** Human status chip; «needs attention» carries its reason in plain words. */
export function AgentStatus({
  status,
  withReason = false,
}: {
  status: HumanStatus;
  withReason?: boolean;
}) {
  const { t } = useTranslation();
  const label = humanStatusLabel(t, status);
  return (
    <span className="agent-status-line">
      <span
        className={cx("agent-status", `agent-status--${statusTone(status)}`)}
      >
        <i aria-hidden="true" />
        {label}
      </span>
      {withReason && status.kind === "attention" && (
        <small>{t(status.reason)}</small>
      )}
    </span>
  );
}
