import { useQuery } from "@tanstack/react-query";
import type {
  AgentRun,
  Chat,
  MessengerAPI,
} from "@comamessenger/core";
import { AlertCircle, CheckCircle2, Clock, Wallet } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  runFinished,
  runPreview,
  runSeconds,
  stepText,
} from "@comamessenger/core";
import {
  agentRunErrorText,
  chatName,
  formatCost,
  formatDuration,
} from "../shared/format";

/** «Read the chat», «Would send a card»: lives in Core, shared with the phone. */
export { stepText };

/** Answer, trace (what it read, what it would do, time, cost) and verdict. */
export function CheckResult({
  api,
  run,
  chat,
}: {
  api: MessengerAPI;
  run: AgentRun;
  chat: Chat | undefined;
}) {
  const { t, i18n } = useTranslation();
  const done = runFinished(run);
  const steps = useQuery({
    queryKey: ["agent-run-steps", run.id],
    queryFn: () => api.agentRunToolCalls(run.id),
    enabled: done,
  });
  const fragments = useQuery({
    queryKey: ["agent-run-fragments", run.id],
    queryFn: () => api.knowledgeRunFragments(run.id),
    enabled: done,
    retry: false,
  });
  const preview = runPreview(run);
  const calls = steps.data?.tool_calls ?? [];
  const reads = calls.filter((call) => !call.dry_run && call.mode === "read");
  const wouldDo = calls.filter((call) => call.dry_run);
  const documents = [
    ...new Map(
      (fragments.data?.fragments ?? []).map((fragment) => [
        fragment.document_id,
        fragment,
      ]),
    ).values(),
  ];
  const where = chat ? chatName(chat) : "";

  if (!done)
    return (
      <div className="agent-check__bubble agent-check__bubble--pending">
        {t(`agentRunStatus_${run.status}`)}
      </div>
    );

  return (
    <div className="agent-check__result">
      {run.status === "completed" && preview ? (
        <div className="agent-check__bubble">{preview}</div>
      ) : null}
      <div className="agent-trace">
        <strong>{t("agentTraceTitle")}</strong>
        <ul>
          {reads.map((call) => (
            <li key={call.id}>{stepText(t, call)}</li>
          ))}
          {documents.map((fragment) => (
            <li key={fragment.document_id}>
              {fragment.section
                ? t("agentTraceDocumentSection", {
                    title: fragment.document_title,
                    section: fragment.section,
                  })
                : t("agentTraceDocument", { title: fragment.document_title })}
            </li>
          ))}
          {wouldDo.map((call) => (
            <li key={call.id} className="agent-trace__would">
              {stepText(t, call)}
            </li>
          ))}
          {steps.isSuccess && calls.length === 0 && (
            <li>{t("agentTraceNoSteps")}</li>
          )}
        </ul>
        <span className="agent-trace__meta">
          <span>
            <Clock aria-hidden="true" />
            {formatDuration(t, runSeconds(run))}
          </span>
          <span>
            <Wallet aria-hidden="true" />
            {t("agentTraceCost", {
              cost: formatCost(run.cost, run.currency, i18n.language),
            })}
          </span>
        </span>
      </div>
      {run.status === "completed" ? (
        <p className="agent-verdict agent-verdict--success" role="status">
          <CheckCircle2 aria-hidden="true" />
          <span>
            {preview
              ? where
                ? t("agentVerdictAnswered", { chat: where })
                : t("agentVerdictAnsweredNoChat")
              : t("agentVerdictSilent")}
            {wouldDo.length > 0 &&
              ` ${t("agentVerdictWouldAlso", { count: wouldDo.length })}`}
          </span>
        </p>
      ) : (
        <p className="agent-verdict agent-verdict--danger" role="alert">
          <AlertCircle aria-hidden="true" />
          <span>
            {run.status === "canceled"
              ? t("agentVerdictCanceled")
              : run.status === "timed_out"
                ? t("agentRunError_run_timeout")
                : agentRunErrorText(t, run.error_code)}
          </span>
        </p>
      )}
    </div>
  );
}
