import { StyleSheet, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, Clock, Wallet } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  agentRunErrorText,
  chatName,
  formatCost,
  formatDuration,
  stepText,
  toolLabel,
  type AgentRun,
  type Chat,
} from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { useSignedIn } from "@/session/SessionProvider";
import { Text } from "@/ui/Text";
import { agentKeys } from "../../data";
import { RunDocumentRow, useRunDocuments } from "../../RunDocuments";

export { useAgentCheck } from "../../useAgentCheck";

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
  run,
  chat,
}: {
  run: AgentRun;
  chat: Chat | undefined;
}) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const { api } = useSignedIn();
  const done = terminal(run);
  const steps = useQuery({
    queryKey: agentKeys.steps(run.id),
    queryFn: () => api.agentRunToolCalls(run.id),
    enabled: done,
  });
  const { documents } = useRunDocuments(run.id, done);
  const preview =
    typeof run.result_summary.preview === "string"
      ? run.result_summary.preview
      : "";
  const calls = steps.data?.tool_calls ?? [];
  const label = (name: string) => toolLabel(t, name);
  const reads = calls.filter((call) => !call.dry_run && call.mode === "read");
  const wouldDo = calls.filter((call) => call.dry_run);
  const where = chat ? chatName(chat) : "";

  if (!done)
    return (
      <View
        style={[
          styles.bubble,
          { backgroundColor: theme.surface, borderColor: theme.border },
        ]}
      >
        <Text tone="muted" size={15}>
          {t(`agentRunStatus_${run.status}`)}
        </Text>
      </View>
    );

  return (
    <View style={styles.result} testID="agent-check-result">
      {run.status === "completed" && preview ? (
        <View
          style={[
            styles.bubble,
            { backgroundColor: theme.surface, borderColor: theme.border },
          ]}
        >
          <Text size={15.5} selectable>
            {preview}
          </Text>
        </View>
      ) : null}
      <View style={[styles.trace, { backgroundColor: theme.sidebar }]}>
        <Text weight="semibold" size={14}>
          {t("agentTraceTitle")}
        </Text>
        {reads.map((call) => (
          <Text key={call.id} size={14} tone="muted">
            • {stepText(t, call, label)}
          </Text>
        ))}
        {documents.map((document, index) => (
          <RunDocumentRow
            key={document.document_id}
            testID={`agent-check-document-${index}`}
            document={document}
            compact
          />
        ))}
        {wouldDo.map((call) => (
          <Text key={call.id} size={14} style={{ color: theme.primary }}>
            • {stepText(t, call, label)}
          </Text>
        ))}
        {steps.isSuccess && calls.length === 0 ? (
          <Text size={14} tone="muted">
            • {t("agentTraceNoSteps")}
          </Text>
        ) : null}
        <View style={styles.meta}>
          <Clock size={14} color={theme.muted} />
          <Text tone="muted" size={13}>
            {formatDuration(t, seconds(run))}
          </Text>
          <Wallet size={14} color={theme.muted} />
          <Text tone="muted" size={13}>
            {t("agentTraceCost", {
              cost: formatCost(run.cost, run.currency, i18n.language),
            })}
          </Text>
        </View>
      </View>
      {run.status === "completed" ? (
        <View
          accessibilityRole="text"
          style={[styles.verdict, { backgroundColor: theme.successSoft }]}
        >
          <CheckCircle2 size={18} color={theme.successText} />
          <Text size={14.5} style={[styles.grow, { color: theme.successText }]}>
            {preview
              ? where
                ? t("agentVerdictAnswered", { chat: where })
                : t("agentVerdictAnsweredNoChat")
              : t("agentVerdictSilent")}
            {wouldDo.length > 0
              ? ` ${t("agentVerdictWouldAlso", { count: wouldDo.length })}`
              : ""}
          </Text>
        </View>
      ) : (
        <View
          accessibilityRole="alert"
          style={[styles.verdict, { backgroundColor: theme.dangerSoft }]}
        >
          <AlertCircle size={18} color={theme.danger} />
          <Text size={14.5} tone="danger" style={styles.grow}>
            {run.status === "canceled"
              ? t("agentVerdictCanceled")
              : run.status === "timed_out"
                ? t("agentRunError_run_timeout")
                : agentRunErrorText(t, run.error_code)}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  result: { gap: spacing[2] },
  bubble: {
    borderRadius: radius.bubble,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing[3],
  },
  trace: { borderRadius: radius.md, padding: spacing[3], gap: spacing[1] },
  meta: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[1],
    marginTop: spacing[1],
  },
  verdict: {
    flexDirection: "row",
    gap: spacing[2],
    alignItems: "flex-start",
    padding: spacing[3],
    borderRadius: radius.md,
  },
  grow: { flex: 1 },
});
