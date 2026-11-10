import { useQuery } from "@tanstack/react-query";
import type {
  AgentRun,
  AgentRunToolCall,
  Chat,
  MessengerAPI,
} from "@comamessenger/core";
import { AlertCircle, CheckCircle2, Clock, Wallet } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  agentRunErrorText,
  chatName,
  formatCost,
  formatDuration,
  toolLabel,
  type Translate,
} from "../shared/format";

const knownSteps = new Set([
  "get_chat_messages",
  "get_thread",
  "search_messages",
  "get_file_text",
  "list_members",
  "recall",
  "search_knowledge",
  "get_reactions",
  "get_collection",
  "post_message",
  "reply_in_thread",
  "add_reaction",
  "remember",
  "post_card",
  "update_card",
  "start_collection",
  "schedule_followup",
  "send_direct_message",
]);

/** «Read the chat», «Would send a card»: a tool step in plain words. */
export function stepText(t: Translate, call: AgentRunToolCall): string {
  const known = knownSteps.has(call.tool_name);
  const text = known
    ? t(
        call.dry_run
          ? `agentStepWould_${call.tool_name}`
          : `agentStep_${call.tool_name}`,
      )
    : call.dry_run
      ? t("agentStepWouldExternal", { name: toolLabel(t, call.tool_name) })
      : t("agentStepExternal", { name: toolLabel(t, call.tool_name) });
  return call.status === "failed" ? t("agentStepFailed", { step: text }) : text;
}

const terminal = (run: AgentRun) => !["queued", "running"].includes(run.status);

function seconds(run: AgentRun) {
  if (!run.started_at || !run.finished_at) return 0;
  return (
    (new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()) /
    1000
  );
}

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
  const done = terminal(run);
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
  const preview =
    typeof run.result_summary.preview === "string"
      ? run.result_summary.preview
      : "";
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
            {formatDuration(t, seconds(run))}
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
