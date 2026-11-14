import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import {
  AlertCircle,
  BookOpen,
  CheckCircle2,
  ChevronRight,
  Eye,
  MessageCircle,
  PenLine,
} from "lucide-react-native";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  chatName,
  formatCost,
  formatDateTime,
  formatDuration,
  runErrorText,
  runFailed,
  runFinished,
  runPreview,
  runSeconds,
  runSentence,
  runTrigger,
  stepText,
  type AgentRun,
  type AgentRunToolCall,
} from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { isNetworkError, messageOf } from "@/lib/errors";
import { useTheme } from "@/lib/theme";
import { useSignedIn } from "@/session/SessionProvider";
import { Avatar } from "@/ui/Avatar";
import { Notice } from "@/ui/Notice";
import { ScreenHeader } from "@/ui/ScreenHeader";
import {
  Divider,
  GroupBody,
  InfoRow,
  NavRow,
  SettingsGroup,
} from "@/ui/Settings";
import { Text } from "@/ui/Text";
import { agentKeys, useAgentAccess, useAgents, useKnownChats } from "./data";
import { Pill } from "./parts";
import { agentHref } from "./routes";

export function runTone(run: AgentRun) {
  if (runFailed(run)) return "danger" as const;
  if (!runFinished(run)) return "warning" as const;
  if (run.status === "canceled") return "neutral" as const;
  return "success" as const;
}

export function triggerLabel(t: (key: string) => string, run: AgentRun) {
  const trigger = runTrigger(run);
  return trigger === "check"
    ? t("agentRunTrigger_check")
    : t(`acWhy_${trigger}`);
}

/**
 * One run of an agent: what started it, what it read and did step by step,
 * its answer, time, tokens, cost and the error in words.
 */
export function RunScreen({ runID }: { runID: string }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { api } = useSignedIn();
  const { canView } = useAgentAccess();
  const run = useQuery({
    queryKey: agentKeys.run(runID),
    queryFn: () => api.agentRun(runID),
    enabled: canView,
    refetchInterval: (query) =>
      query.state.data && !runFinished(query.state.data) ? 2_000 : false,
  });
  return (
    <SafeAreaView
      testID="run-screen"
      edges={["bottom"]}
      style={[styles.screen, { backgroundColor: theme.canvas }]}
    >
      <ScreenHeader backTestID="run-back" title={t("agentRunTitle")} />
      {!canView ? (
        <View style={styles.state}>
          <Notice
            tone="neutral"
            title={t("settingsNoAccess")}
            hint={t("agentNoAccessHint")}
          />
        </View>
      ) : run.isPending ? (
        <ActivityIndicator style={styles.loader} color={theme.muted} />
      ) : run.isError && !run.data ? (
        <View style={styles.state}>
          <Notice
            title={
              isNetworkError(run.error)
                ? t("settingsOffline")
                : t("agentRunLoadFailed")
            }
            hint={
              isNetworkError(run.error)
                ? t("settingsOfflineHint")
                : messageOf(run.error)
            }
            actionLabel={t("retry")}
            onAction={() => void run.refetch()}
          />
        </View>
      ) : (
        <RunDetails run={run.data} refetch={run.refetch} />
      )}
    </SafeAreaView>
  );
}

function RunDetails({
  run,
  refetch,
}: {
  run: AgentRun;
  refetch(): Promise<unknown>;
}) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const { api } = useSignedIn();
  const agents = useAgents();
  const chats = useKnownChats();
  const agent = agents.data?.find((item) => item.id === run.agent_id);
  const chat = chats.find((item) => item.id === run.chat_id);
  const done = runFinished(run);
  const steps = useQuery({
    queryKey: agentKeys.steps(run.id),
    queryFn: () => api.agentRunToolCalls(run.id),
    enabled: done,
  });
  const fragments = useQuery({
    queryKey: agentKeys.fragments(run.id),
    queryFn: () => api.knowledgeRunFragments(run.id),
    enabled: done,
    retry: false,
  });
  const preview = runPreview(run);
  const calls = steps.data?.tool_calls ?? [];
  const documents = [
    ...new Map(
      (fragments.data?.fragments ?? []).map((fragment) => [
        fragment.document_id,
        fragment,
      ]),
    ).values(),
  ];
  const name = agent?.display_name ?? t("agentUnknown");
  const time = (value: string | null | undefined) =>
    value ? formatDateTime(value, i18n.language) : "—";

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={false}
          onRefresh={() =>
            void Promise.all([refetch(), steps.refetch(), fragments.refetch()])
          }
          tintColor={theme.muted}
        />
      }
    >
      <Pressable
        testID="run-agent"
        accessibilityRole="button"
        accessibilityLabel={`${name} ${runSentence(t, run, chats)}`}
        onPress={() => router.push(agentHref.agent(run.agent_id) as never)}
        style={({ pressed }) => [
          styles.hero,
          {
            backgroundColor: pressed ? theme.surfaceSelected : theme.surface,
            borderColor: theme.border,
          },
        ]}
      >
        <Avatar
          name={name}
          seed={run.agent_id}
          actorID={run.agent_id}
          avatarVersion={agent?.avatar_version}
          size={44}
          agent
        />
        <View style={styles.grow}>
          <Text size={16}>
            <Text weight="semibold" size={16}>
              {name}
            </Text>{" "}
            {runSentence(t, run, chats)}
          </Text>
          <View style={styles.pills}>
            <Pill
              testID="run-status"
              label={t(`agentRunStatus_${run.status}`)}
              tone={runTone(run)}
            />
            {run.dry_run ? (
              <Pill label={t("agentRunDry")} tone="neutral" />
            ) : null}
          </View>
        </View>
        <ChevronRight size={20} color={theme.subtle} />
      </Pressable>

      {runFailed(run) || run.status === "canceled" ? (
        <Notice
          tone={run.status === "canceled" ? "neutral" : "danger"}
          title={runErrorText(t, run)}
          hint={
            run.error_code
              ? t("agentRunErrorCode", { code: run.error_code })
              : undefined
          }
        />
      ) : null}

      {preview ? (
        <SettingsGroup title={t("agentRunAnswer")}>
          <GroupBody>
            <Text selectable size={15}>
              {preview}
            </Text>
          </GroupBody>
        </SettingsGroup>
      ) : null}

      <SettingsGroup title={t("agentTraceTitle")}>
        {!done ? (
          <GroupBody>
            <View style={styles.row}>
              <ActivityIndicator color={theme.muted} />
              <Text tone="muted" size={14}>
                {t(`agentRunStatus_${run.status}`)}
              </Text>
            </View>
          </GroupBody>
        ) : steps.isPending ? (
          <ActivityIndicator style={styles.inline} color={theme.muted} />
        ) : steps.isError ? (
          <GroupBody>
            <Notice
              title={t("agentStepsLoadFailed")}
              actionLabel={t("retry")}
              onAction={() => void steps.refetch()}
            />
          </GroupBody>
        ) : calls.length === 0 && documents.length === 0 ? (
          <GroupBody>
            <Text tone="muted" size={14}>
              {t("agentTraceNoSteps")}
            </Text>
          </GroupBody>
        ) : (
          <>
            {calls.map((call, index) => (
              <View key={call.id}>
                {index > 0 && <Divider />}
                <StepRow testID={`run-step-${index}`} call={call} />
              </View>
            ))}
            {documents.map((fragment) => (
              <View key={fragment.document_id}>
                <Divider />
                <View accessible style={styles.step}>
                  <BookOpen size={18} color={theme.muted} />
                  <Text size={14.5} style={styles.grow}>
                    {fragment.section
                      ? t("agentTraceDocumentSection", {
                          title: fragment.document_title,
                          section: fragment.section,
                        })
                      : t("agentTraceDocument", {
                          title: fragment.document_title,
                        })}
                  </Text>
                </View>
              </View>
            ))}
          </>
        )}
      </SettingsGroup>

      <SettingsGroup title={t("agentRunFacts")}>
        <InfoRow label={t("agentRunTrigger")} value={triggerLabel(t, run)} />
        <Divider />
        {chat ? (
          <NavRow
            testID="run-chat"
            icon={MessageCircle}
            label={t("agentRunChat")}
            value={chatName(chat)}
            onPress={() => router.push(`/chat/${chat.id}`)}
          />
        ) : (
          <InfoRow
            label={t("agentRunChat")}
            value={run.chat_id ? t("agentChatHidden") : "—"}
          />
        )}
        <Divider />
        <InfoRow
          label={t("agentRunStarted")}
          value={time(run.started_at ?? run.created_at)}
        />
        <Divider />
        <InfoRow label={t("agentRunFinished")} value={time(run.finished_at)} />
        <Divider />
        <InfoRow
          label={t("agentRunDuration")}
          value={formatDuration(t, runSeconds(run))}
        />
        <Divider />
        <InfoRow
          testID="run-cost"
          label={t("agentRunCost")}
          value={formatCost(run.cost, run.currency, i18n.language)}
        />
        <Divider />
        <InfoRow
          label={t("agentRunTokens")}
          value={t("agentRunTokensValue", {
            input: run.input_tokens,
            output: run.output_tokens,
          })}
        />
        {run.model ? (
          <>
            <Divider />
            <InfoRow label={t("agentModel")} value={run.model} />
          </>
        ) : null}
        {run.max_attempts > 1 ? (
          <>
            <Divider />
            <InfoRow
              label={t("agentRunAttempt")}
              value={t("agentRunAttemptValue", {
                attempt: run.attempt,
                max: run.max_attempts,
              })}
            />
          </>
        ) : null}
        {run.agent_version ? (
          <>
            <Divider />
            <InfoRow
              label={t("agentVersion")}
              value={t("agentVersionShort", { version: run.agent_version })}
            />
          </>
        ) : null}
      </SettingsGroup>
    </ScrollView>
  );
}

function StepRow({
  call,
  testID,
}: {
  call: AgentRunToolCall;
  testID?: string;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const failed = call.status === "failed";
  const Icon = failed
    ? AlertCircle
    : call.dry_run
      ? Eye
      : call.mode === "write"
        ? PenLine
        : CheckCircle2;
  const seconds =
    call.finished_at && call.started_at
      ? (new Date(call.finished_at).getTime() -
          new Date(call.started_at).getTime()) /
        1000
      : 0;
  return (
    <View testID={testID} accessible style={styles.step}>
      <Icon size={18} color={failed ? theme.danger : theme.muted} />
      <View style={styles.grow}>
        <Text
          size={14.5}
          style={failed ? { color: theme.dangerText } : undefined}
        >
          {stepText(t, call)}
        </Text>
        <Text tone="muted" size={12.5}>
          {[
            call.mode === "write"
              ? t("agentStepModeWrite")
              : t("agentStepModeRead"),
            call.status === "running" ? t("agentRunStatus_running") : "",
            seconds > 0 ? formatDuration(t, seconds) : "",
            failed && call.error_code
              ? t("agentRunErrorCode", { code: call.error_code })
              : "",
          ]
            .filter(Boolean)
            .join(" · ")}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  state: { padding: spacing[4] },
  loader: { marginTop: spacing[10] },
  inline: { marginVertical: spacing[4] },
  content: {
    padding: spacing[4],
    gap: spacing[5],
    paddingBottom: spacing[10],
    width: "100%",
    maxWidth: 640,
    alignSelf: "center",
  },
  hero: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[3],
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing[4],
  },
  grow: { flex: 1 },
  pills: { flexDirection: "row", gap: 6, marginTop: 6, flexWrap: "wrap" },
  row: { flexDirection: "row", alignItems: "center", gap: spacing[2] },
  step: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
  },
});
