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
  const label =
    status.kind === "approval"
      ? t("agentStatus_approval", { count: status.count })
      : status.kind === "working" && status.changed
        ? t("agentStatus_workingChanged")
        : t(`agentStatus_${status.kind}`);
  return (
    <span className="agent-status-line">
      <span className={cx("agent-status", `agent-status--${statusTone(status)}`)}>
        <i aria-hidden="true" />
        {label}
      </span>
      {withReason && status.kind === "attention" && (
        <small>{t(status.reason)}</small>
      )}
    </span>
  );
}
