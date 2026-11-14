import { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Clock,
  Wallet,
} from "lucide-react-native";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  chatName,
  checkBlockers,
  customExampleCount,
  formatCost,
  formatDuration,
  recipeOf,
  runErrorText,
  runFinished,
  runPreview,
  runSeconds,
  stepText,
  type Agent,
  type AgentRun,
  type Chat,
} from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { useSignedIn } from "@/session/SessionProvider";
import { Avatar } from "@/ui/Avatar";
import { Button } from "@/ui/Button";
import { Notice } from "@/ui/Notice";
import { PickerSheet } from "@/ui/PickerSheet";
import { ScreenHeader } from "@/ui/ScreenHeader";
import { Divider, NavRow, SettingsGroup } from "@/ui/Settings";
import { Text } from "@/ui/Text";
import { TextField } from "@/ui/TextField";
import {
  agentKeys,
  useAgent,
  useAgentAccess,
  useKnownChats,
  useRecipes,
} from "./data";
import { agentHref, canEditAgent } from "./routes";
import { RunDocumentRow, useRunDocuments } from "./RunDocuments";
import { useAgentCheck } from "./useAgentCheck";

/**
 * «Проверка»: ready examples of the role, the answer of the agent draft in a
 * dry run and a human trace. Nothing is sent to chats.
 */
export function CheckScreen({ agentID }: { agentID: string }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const access = useAgentAccess();
  const { agent, query } = useAgent(agentID);
  return (
    <SafeAreaView
      testID="check-screen"
      edges={["bottom"]}
      style={[styles.screen, { backgroundColor: theme.canvas }]}
    >
      <ScreenHeader
        backTestID="check-back"
        title={t("agentCheckTitle")}
        subtitle={agent?.display_name}
      />
      {!access.canBuild ? (
        <View style={styles.state}>
          <Notice tone="neutral" title={t("agentCheckNoRights")} />
        </View>
      ) : query.isPending ? (
        <ActivityIndicator style={styles.loader} color={theme.muted} />
      ) : !agent ? (
        <View style={styles.state}>
          <Notice
            tone="neutral"
            title={t("agentNotFound")}
            hint={t("agentNotFoundHint")}
          />
        </View>
      ) : (
        <KeyboardAvoidingView
          style={styles.screen}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <CheckPanel agent={agent} />
        </KeyboardAvoidingView>
      )}
    </SafeAreaView>
  );
}

function CheckPanel({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const access = useAgentAccess();
  const chats = useKnownChats();
  const recipes = useRecipes();
  const recipe = recipeOf(recipes.data, agent);
  const agentChats = chats.filter((chat) => agent.chat_ids.includes(chat.id));
  const [chatID, setChatID] = useState(agentChats[0]?.id ?? "");
  const [prompt, setPrompt] = useState("");
  const [picking, setPicking] = useState(false);
  const { run, error, pending, start: startCheck, stop } = useAgentCheck(agent);

  const selected =
    agentChats.find((chat) => chat.id === chatID) ?? agentChats[0];
  const blocking = agent.readiness.blockers.filter((blocker) =>
    checkBlockers.has(blocker),
  );
  const examples = recipe
    ? recipe.checks
    : Array.from({ length: customExampleCount }, (_, index) => ({
        prompt: t(`agentExample_custom_${index + 1}`),
        expectations: [] as string[],
      }));
  const expected = examples.find(
    (item) => item.prompt === prompt,
  )?.expectations;

  function start() {
    if (!selected || !prompt.trim()) return;
    void startCheck(selected.id, prompt.trim());
  }

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
    >
      <Text tone="muted" size={14}>
        {t("agentCheckLead")}
      </Text>

      <View style={styles.block}>
        <Text weight="medium" size={14}>
          {t("agentCheckExamples")}
        </Text>
        <View style={styles.chips} accessibilityRole="radiogroup">
          {examples.map((example, index) => (
            <Pressable
              key={example.prompt}
              testID={`check-example-${index}`}
              accessibilityRole="radio"
              accessibilityState={{ checked: prompt === example.prompt }}
              onPress={() => setPrompt(example.prompt)}
              style={[
                styles.example,
                {
                  backgroundColor:
                    prompt === example.prompt
                      ? theme.primarySoft
                      : theme.surface,
                  borderColor:
                    prompt === example.prompt ? theme.primary : theme.border,
                },
              ]}
            >
              <Text size={14}>{example.prompt}</Text>
            </Pressable>
          ))}
        </View>
        {expected && expected.length > 0 ? (
          <View style={[styles.expect, { backgroundColor: theme.sidebar }]}>
            <Text weight="medium" size={13.5}>
              {t("agentCheckExpect")}
            </Text>
            {expected.map((line) => (
              <Text key={line} tone="muted" size={13.5}>
                • {line}
              </Text>
            ))}
          </View>
        ) : null}
      </View>

      {agentChats.length === 0 ? (
        <Notice tone="neutral" title={t("agentCheckNoChat")} />
      ) : agentChats.length > 1 ? (
        <SettingsGroup>
          <NavRow
            testID="check-chat"
            label={t("agentCheckChat")}
            value={selected ? chatName(selected) : ""}
            onPress={() => setPicking(true)}
          />
        </SettingsGroup>
      ) : (
        <Text tone="muted" size={14}>
          {t("agentCheckInChat", { chat: chatName(selected!) })}
        </Text>
      )}

      <TextField
        testID="check-message"
        label={t("agentCheckMessage")}
        multiline
        value={prompt}
        placeholder={t("agentCheckMessagePlaceholder")}
        onChangeText={setPrompt}
      />

      {blocking.length > 0 && (
        <View style={styles.block}>
          <Notice
            tone="neutral"
            title={t("agentCheckNeeds")}
            hint={blocking
              .map((key) => `• ${t(`agentBlocker_${key}`)}`)
              .join("\n")}
          />
          {canEditAgent(access) ? (
            <Button
              variant="secondary"
              label={t("agentEdit")}
              onPress={() => router.push(agentHref.edit(agent.id) as never)}
            />
          ) : null}
        </View>
      )}

      {pending ? (
        <View style={styles.thinking}>
          <ActivityIndicator color={theme.muted} />
          <Text tone="muted" size={14.5} style={styles.grow}>
            {t("agentCheckThinking")}
          </Text>
          <Button
            testID="check-stop"
            variant="ghost"
            label={t("agentCheckStop")}
            onPress={stop}
          />
        </View>
      ) : (
        <Button
          testID="check-run"
          label={run ? t("agentCheckAgain") : t("agentCheckRun")}
          disabled={blocking.length > 0 || !prompt.trim() || !selected}
          onPress={start}
        />
      )}

      {error ? <Notice title={t("agentCheckFailed")} hint={error} /> : null}

      {run ? (
        <View style={styles.answer}>
          <Avatar
            name={agent.display_name}
            seed={agent.id}
            actorID={agent.id}
            avatarVersion={agent.avatar_version}
            size={32}
            agent
          />
          <View style={styles.grow}>
            <CheckResult run={run} chat={selected} />
          </View>
        </View>
      ) : null}

      <PickerSheet<string>
        testID="check-chat-picker"
        visible={picking}
        title={t("agentCheckChat")}
        value={selected?.id ?? ""}
        options={agentChats.map((chat) => ({
          value: chat.id,
          label: chatName(chat),
        }))}
        onSelect={setChatID}
        onClose={() => setPicking(false)}
      />
    </ScrollView>
  );
}

/** Answer, trace (what it read, what it would do, time, cost) and verdict. */
function CheckResult({ run, chat }: { run: AgentRun; chat: Chat | undefined }) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const { api } = useSignedIn();
  const done = runFinished(run);
  const steps = useQuery({
    queryKey: agentKeys.steps(run.id),
    queryFn: () => api.agentRunToolCalls(run.id),
    enabled: done,
  });
  const { documents } = useRunDocuments(run.id, done);
  const preview = runPreview(run);
  const calls = steps.data?.tool_calls ?? [];
  const reads = calls.filter((call) => !call.dry_run && call.mode === "read");
  const wouldDo = calls.filter((call) => call.dry_run);
  const where = chat ? chatName(chat) : "";
  const bubble = [
    styles.bubble,
    { backgroundColor: theme.surface, borderColor: theme.border },
  ];

  if (!done)
    return (
      <View style={bubble}>
        <Text tone="muted" size={14.5}>
          {t(`agentRunStatus_${run.status}`)}
        </Text>
      </View>
    );

  return (
    <View style={styles.block} testID="check-result">
      {run.status === "completed" && preview ? (
        <View style={bubble}>
          <Text selectable size={15}>
            {preview}
          </Text>
        </View>
      ) : null}
      <SettingsGroup title={t("agentTraceTitle")}>
        {reads.map((call, index) => (
          <View key={call.id}>
            {index > 0 && <Divider />}
            <Text size={14} style={styles.trace}>
              {stepText(t, call)}
            </Text>
          </View>
        ))}
        {documents.map((document, index) => (
          <View key={document.document_id}>
            <Divider />
            <RunDocumentRow
              testID={`check-document-${index}`}
              document={document}
            />
          </View>
        ))}
        {wouldDo.map((call) => (
          <View key={call.id}>
            <Divider />
            <Text tone="primary" size={14} style={styles.trace}>
              {stepText(t, call)}
            </Text>
          </View>
        ))}
        {steps.isSuccess && calls.length === 0 ? (
          <Text tone="muted" size={14} style={styles.trace}>
            {t("agentTraceNoSteps")}
          </Text>
        ) : null}
        <Divider />
        <View style={styles.meta}>
          <Clock size={14} color={theme.muted} />
          <Text tone="muted" size={13}>
            {formatDuration(t, runSeconds(run))}
          </Text>
          <Wallet size={14} color={theme.muted} />
          <Text tone="muted" size={13}>
            {t("agentTraceCost", {
              cost: formatCost(run.cost, run.currency, i18n.language),
            })}
          </Text>
        </View>
      </SettingsGroup>
      {run.status === "completed" ? (
        <View
          accessibilityRole="summary"
          style={[styles.verdict, { backgroundColor: theme.successSoft }]}
        >
          <CheckCircle2 size={18} color={theme.successText} />
          <Text size={14.5} style={[styles.grow, { color: theme.successText }]}>
            {(preview
              ? where
                ? t("agentVerdictAnswered", { chat: where })
                : t("agentVerdictAnsweredNoChat")
              : t("agentVerdictSilent")) +
              (wouldDo.length > 0
                ? ` ${t("agentVerdictWouldAlso", { count: wouldDo.length })}`
                : "")}
          </Text>
        </View>
      ) : (
        <View
          accessibilityRole="alert"
          style={[styles.verdict, { backgroundColor: theme.dangerSoft }]}
        >
          <AlertCircle size={18} color={theme.danger} />
          <Text size={14.5} style={[styles.grow, { color: theme.dangerText }]}>
            {runErrorText(t, run)}
          </Text>
        </View>
      )}
      <Pressable
        accessibilityRole="link"
        onPress={() => router.push(agentHref.run(run.id) as never)}
        style={styles.traceRow}
      >
        <Text tone="primary" size={13.5} weight="medium" style={styles.grow}>
          {t("agentRunOpen")}
        </Text>
        <ChevronRight size={16} color={theme.primary} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  state: { padding: spacing[4] },
  loader: { marginTop: spacing[10] },
  content: {
    padding: spacing[4],
    gap: spacing[4],
    paddingBottom: spacing[10],
    width: "100%",
    maxWidth: 640,
    alignSelf: "center",
  },
  block: { gap: spacing[2] },
  chips: { gap: spacing[2] },
  example: {
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
  },
  expect: { borderRadius: radius.md, padding: spacing[3], gap: 2 },
  thinking: { flexDirection: "row", alignItems: "center", gap: spacing[2] },
  grow: { flex: 1 },
  answer: { flexDirection: "row", gap: spacing[2], alignItems: "flex-start" },
  bubble: {
    borderWidth: 1,
    borderRadius: radius.bubble,
    borderTopLeftRadius: radius.sm,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
  },
  trace: { paddingHorizontal: spacing[4], paddingVertical: spacing[2] },
  traceRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[2],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
  },
  meta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
  },
  verdict: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[2],
    borderRadius: radius.md,
    padding: spacing[3],
  },
});
