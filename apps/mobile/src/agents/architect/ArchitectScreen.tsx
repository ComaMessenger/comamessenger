import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { PlugZap, RotateCcw, Send, Sparkles } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  architectProblemKey,
  formatCost,
  type ArchitectMessage,
  type ArchitectProblem,
  type ArchitectTestExample,
} from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { connectionsPaths } from "@/connections/paths";
import { Button } from "@/ui/Button";
import { IconButton } from "@/ui/IconButton";
import { Notice } from "@/ui/Notice";
import { ScreenHeader } from "@/ui/ScreenHeader";
import { Text, fonts, maxTextScale } from "@/ui/Text";
import {
  AgentBuilderProvider,
  useAgentBuilder,
} from "../builder/AgentBuilderProvider";
import { CheckResult, useAgentCheck } from "../builder/check/CheckResult";
import { Chip, ChipRow } from "../builder/controls";
import {
  agentBuilderPaths,
  agentKeys,
  useAgentAccess,
  useAgents,
} from "../builder/data";
import { LoosenedSheet, usePublishState } from "../builder/publish";
import { PassportBar, PassportSheet } from "./Passport";
import { useArchitect } from "./useArchitect";

/**
 * The Architect: an agent that builds an agent by talking. The conversation
 * reads like a chat; the draft it saves grows in the passport above, and once
 * it is assembled the screen offers the check, the builder and the publish.
 */
export function ArchitectScreen({ agentID }: { agentID: string | null }) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const queryClient = useQueryClient();
  const access = useAgentAccess();
  const agents = useAgents();
  const locale = i18n.language.startsWith("en") ? "en" : "ru";
  const architect = useArchitect({
    agentID,
    locale,
    onDraft: (next) => {
      // The passport shows the saved draft: reread it after every answer.
      void agents.refetch();
      if (next.agent_id)
        void queryClient.invalidateQueries({
          queryKey: agentKeys.triggers(next.agent_id),
        });
    },
  });
  const { session, problem, loading, sending, thinking } = architect;
  const draftID = session?.agent_id ?? agentID;
  const agent = agents.data?.find((item) => item.id === draftID);
  const [text, setText] = useState("");
  const [passport, setPassport] = useState(false);
  const scroll = useRef<ScrollView>(null);
  const messageCount = session?.messages.length ?? 0;
  useEffect(() => {
    const timer = setTimeout(
      () => scroll.current?.scrollToEnd({ animated: true }),
      60,
    );
    return () => clearTimeout(timer);
  }, [messageCount, sending, thinking]);

  async function submit(value: string) {
    const trimmed = value.trim();
    if (!trimmed) return;
    setText("");
    if (!(await architect.send(trimmed))) setText(trimmed);
  }

  const header = (
    <ScreenHeader
      title={t("architectTitle")}
      subtitle={
        agent && agentID
          ? t("architectLeadExisting", { name: agent.display_name })
          : t("architectLeadShort")
      }
      leading={
        <View style={[styles.avatar, { backgroundColor: theme.primarySoft }]}>
          <Sparkles size={18} color={theme.primary} />
        </View>
      }
      trailing={
        session ? (
          <IconButton
            testID="architect-restart"
            label={t("architectRestart")}
            disabled={Boolean(sending)}
            onPress={() => {
              setText("");
              void architect.restart();
            }}
            icon={(color) => <RotateCcw size={20} color={color} />}
          />
        ) : undefined
      }
    />
  );

  if (!access.canBuild)
    return (
      <Shell header={header}>
        <View style={styles.state}>
          <Notice
            tone="neutral"
            title={t("settingsNoAccess")}
            hint={t("agentCheckNoRights")}
          />
        </View>
      </Shell>
    );
  if (loading && !session)
    return (
      <Shell header={header}>
        <ActivityIndicator style={styles.loader} color={theme.muted} />
      </Shell>
    );
  if (problem?.kind === "connection")
    return (
      <Shell header={header}>
        <View style={styles.state} testID="architect-no-connection">
          <View style={[styles.bigIcon, { backgroundColor: theme.sidebar }]}>
            <PlugZap size={28} color={theme.muted} />
          </View>
          <Notice
            tone="neutral"
            title={t("architectNoConnectionTitle")}
            hint={
              access.canIntegrate
                ? t("architectNoConnectionText")
                : t("architectNoConnectionAsk")
            }
            actionLabel={
              access.canIntegrate ? t("architectNoConnectionAction") : undefined
            }
            onAction={
              access.canIntegrate
                ? () => router.push(connectionsPaths.newModel)
                : undefined
            }
          />
        </View>
      </Shell>
    );
  if (!session)
    return (
      <Shell header={header}>
        <View style={styles.state}>
          <Notice
            title={problemText(t, problem)}
            actionLabel={t("architectRetry")}
            onAction={() => void architect.retry()}
          />
        </View>
      </Shell>
    );

  const last = session.messages[session.messages.length - 1];
  const waitingForAnswer =
    last?.role === "assistant" && last.kind === "question";
  const finished = session.messages.some((message) => message.kind === "done");
  const open = session.status === "active";
  const left = session.max_questions - session.questions_asked;
  const busy = Boolean(sending) || thinking;

  return (
    <Shell header={header} testID="architect-screen">
      {draftID ? (
        <PassportBar agent={agent} onOpen={() => setPassport(true)} />
      ) : null}
      <KeyboardAvoidingView
        style={styles.grow}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          ref={scroll}
          contentContainerStyle={styles.talk}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
        >
          {session.messages.map((message, index) => (
            <Bubble
              key={message.id}
              message={message}
              answerable={
                open &&
                !busy &&
                index === session.messages.length - 1 &&
                waitingForAnswer
              }
              onPick={(option) => void submit(option)}
            />
          ))}
          {sending ? (
            <Bubble
              message={{
                id: "sending",
                role: "user",
                kind: "text",
                text: sending,
                options: [],
                assumptions: [],
                created_at: "",
              }}
              answerable={false}
              onPick={() => undefined}
            />
          ) : null}
          {busy ? <Thinking /> : null}
          {finished && agent ? (
            <AgentBuilderProvider agent={agent} refetchAgents={agents.refetch}>
              <ArchitectFinish examples={session.test_examples ?? []} />
            </AgentBuilderProvider>
          ) : null}
          {problem ? (
            <Notice
              title={problemText(t, problem)}
              actionLabel={
                problem.kind === "model" && text
                  ? t("architectRetry")
                  : undefined
              }
              onAction={
                problem.kind === "model" && text
                  ? () => void submit(text)
                  : undefined
              }
            />
          ) : null}
        </ScrollView>
        {open ? (
          <Composer
            value={text}
            onChange={setText}
            disabled={busy}
            onSend={() => void submit(text)}
            hint={
              finished
                ? undefined
                : t("architectQuestionsLeft", { count: Math.max(left, 0) })
            }
            note={
              session.connection.name
                ? `${t("architectDataNote", { name: session.connection.name })}${
                    Number(session.usage.cost) > 0
                      ? ` ${t("architectUsage", {
                          cost: formatCost(
                            session.usage.cost,
                            session.usage.currency,
                            i18n.language,
                          ),
                        })}`
                      : ""
                  }`
                : undefined
            }
          />
        ) : (
          <View
            style={[
              styles.over,
              { borderTopColor: theme.border, backgroundColor: theme.surface },
            ]}
          >
            <Text tone="muted" size={15}>
              {session.status === "expired"
                ? t("architectExpired")
                : t("architectClosed")}
            </Text>
            <Button
              label={t("architectRestart")}
              onPress={() => void architect.restart()}
            />
          </View>
        )}
      </KeyboardAvoidingView>
      <PassportSheet
        agent={agent}
        visible={passport}
        onClose={() => setPassport(false)}
      />
    </Shell>
  );
}

function Shell({
  header,
  children,
  testID,
}: {
  header: ReactNode;
  children: ReactNode;
  testID?: string;
}) {
  const theme = useTheme();
  return (
    <SafeAreaView
      testID={testID}
      edges={["bottom"]}
      style={[styles.grow, { backgroundColor: theme.canvas }]}
    >
      {header}
      {children}
    </SafeAreaView>
  );
}

function problemText(
  t: (key: string) => string,
  problem: ArchitectProblem | null,
): string {
  return problem?.kind === "other"
    ? problem.message
    : t(architectProblemKey(problem));
}

function Bubble({
  message,
  answerable,
  onPick,
}: {
  message: ArchitectMessage;
  answerable: boolean;
  onPick(option: string): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const mine = message.role === "user";
  const done = message.kind === "done";
  // Older sessions may carry null lists.
  const assumptions = message.assumptions ?? [];
  const options = message.options ?? [];
  return (
    <View
      style={[styles.message, mine && styles.mine]}
      testID={
        mine ? "architect-message-mine" : `architect-message-${message.kind}`
      }
    >
      {!mine ? (
        <View
          style={[styles.avatarSmall, { backgroundColor: theme.primarySoft }]}
        >
          <Sparkles size={14} color={theme.primary} />
        </View>
      ) : null}
      <View style={[styles.body, mine && styles.bodyMine]}>
        <View
          accessible
          accessibilityLabel={`${mine ? t("architectYou") : t("architectTitle")}: ${message.text}`}
          style={[
            styles.bubble,
            mine
              ? {
                  backgroundColor: theme.own,
                  borderBottomRightRadius: radius.sm,
                }
              : {
                  backgroundColor: done ? theme.successSoft : theme.surface,
                  borderColor: done ? theme.successBorder : theme.border,
                  borderWidth: StyleSheet.hairlineWidth,
                  borderBottomLeftRadius: radius.sm,
                },
          ]}
        >
          <Text
            size={15.5}
            selectable
            style={mine ? { color: theme.onOwn } : undefined}
          >
            {message.text}
          </Text>
          {assumptions.length > 0 ? (
            <View style={styles.assumptions}>
              <Text weight="semibold" size={13.5}>
                {t("architectAssumptions")}
              </Text>
              {assumptions.map((item) => (
                <Text key={item} tone="muted" size={13.5}>
                  • {item}
                </Text>
              ))}
            </View>
          ) : null}
        </View>
        {answerable && options.length > 0 ? (
          <ChipRow>
            {options.map((option, index) => (
              <Chip
                key={option}
                testID={`architect-option-${index}`}
                outline
                label={option}
                onPress={() => onPick(option)}
              />
            ))}
          </ChipRow>
        ) : null}
      </View>
    </View>
  );
}

/** «Архитектор думает…» with the seconds it has been thinking. */
function Thinking() {
  const { t } = useTranslation();
  const theme = useTheme();
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(
      () => setSeconds(Math.round((Date.now() - started) / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, []);
  return (
    <View style={styles.message} testID="architect-thinking">
      <View
        style={[styles.avatarSmall, { backgroundColor: theme.primarySoft }]}
      >
        <Sparkles size={14} color={theme.primary} />
      </View>
      <View
        accessibilityLiveRegion="polite"
        accessibilityRole="progressbar"
        style={[
          styles.bubble,
          styles.thinking,
          { backgroundColor: theme.surface, borderColor: theme.border },
        ]}
      >
        <ActivityIndicator size="small" color={theme.muted} />
        <Text tone="muted" size={15}>
          {seconds >= 5
            ? t("architectThinkingFor", { seconds })
            : t("architectThinking")}
        </Text>
      </View>
    </View>
  );
}

function Composer({
  value,
  onChange,
  onSend,
  disabled,
  hint,
  note,
}: {
  value: string;
  onChange(value: string): void;
  onSend(): void;
  disabled: boolean;
  hint?: string;
  note?: string;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  return (
    <View
      style={[
        styles.composer,
        { borderTopColor: theme.border, backgroundColor: theme.surface },
      ]}
    >
      {hint ? (
        <Text tone="muted" size={13}>
          {hint}
        </Text>
      ) : null}
      <View style={styles.inputRow}>
        <TextInput
          testID="architect-input"
          accessibilityLabel={t("architectInputLabel")}
          maxFontSizeMultiplier={maxTextScale}
          value={value}
          onChangeText={onChange}
          editable={!disabled}
          multiline
          maxLength={4000}
          placeholder={t("architectInputPlaceholder")}
          placeholderTextColor={theme.subtle}
          selectionColor={theme.primary}
          style={[
            styles.input,
            {
              color: theme.foreground,
              backgroundColor: theme.canvas,
              borderColor: theme.borderStrong,
            },
          ]}
        />
        <IconButton
          testID="architect-send"
          label={t("architectSend")}
          variant="accent"
          size={44}
          disabled={!value.trim() || disabled}
          onPress={onSend}
          icon={(color) => <Send size={20} color={color} />}
        />
      </View>
      {note ? (
        <Text tone="subtle" size={12.5}>
          {note}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * After the draft is assembled: the examples the Architect proposed with a
 * sandbox check of each, and the ways on — the builder and the publish.
 */
function ArchitectFinish({ examples }: { examples: ArchitectTestExample[] }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const builder = useAgentBuilder();
  const { agent, chats } = builder;
  const check = useAgentCheck(agent);
  const publish = usePublishState();
  const [selected, setSelected] = useState<number | null>(null);
  const agentChats = chats.filter((chat) => agent.chat_ids.includes(chat.id));
  const ready = agent.external_data_sharing_approved && agentChats.length > 0;

  function run(index: number) {
    const example = examples[index];
    if (!example) return;
    const chatID =
      example.chat_id && agent.chat_ids.includes(example.chat_id)
        ? example.chat_id
        : agentChats[0]?.id;
    if (!chatID) return;
    setSelected(index);
    void check.start(chatID, example.prompt);
  }
  const ran = selected === null ? undefined : examples[selected];

  return (
    <View
      style={[
        styles.finish,
        { backgroundColor: theme.surface, borderColor: theme.border },
      ]}
      testID="architect-finish"
    >
      {examples.length > 0 ? (
        <>
          <Text weight="semibold" size={16}>
            {t("architectExamplesTitle")}
          </Text>
          <Text tone="muted" size={14}>
            {t("architectExamplesHint")}
          </Text>
          {examples.map((example, index) => (
            <View
              key={`${index}-${example.prompt}`}
              style={[styles.example, { borderColor: theme.border }]}
            >
              <Text size={15}>«{example.prompt}»</Text>
              <Text tone="muted" size={13.5}>
                {t("architectExpectation", { text: example.expectation })}
              </Text>
              {ready ? (
                <Button
                  testID={`architect-check-${index}`}
                  variant="secondary"
                  label={t("architectCheck")}
                  pending={check.pending && selected === index}
                  disabled={check.pending}
                  onPress={() => run(index)}
                />
              ) : null}
            </View>
          ))}
        </>
      ) : null}
      {!ready ? (
        <Notice
          tone="neutral"
          title={
            agentChats.length === 0
              ? t("agentBlocker_chat_required")
              : t("passportApprovalNeeded")
          }
        />
      ) : null}
      {check.error ? <Notice title={check.error} /> : null}
      {check.run && ran ? (
        <CheckResult
          run={check.run}
          chat={chats.find((chat) => chat.id === check.run?.chat_id)}
        />
      ) : null}
      {builder.error ? <Notice title={builder.error} /> : null}
      {builder.notice ? <Notice tone="success" title={builder.notice} /> : null}
      <View style={styles.finishActions}>
        <View style={styles.grow}>
          <Button
            testID="architect-open-builder"
            variant="secondary"
            label={t("architectOpenBuilder")}
            onPress={() =>
              router.push(
                ready
                  ? agentBuilderPaths.edit(agent.id)
                  : agentBuilderPaths.step(agent.id, "review"),
              )
            }
          />
        </View>
      </View>
      {builder.access.canPublish ? (
        <View style={styles.finishActions}>
          <View style={styles.grow}>
            <Button
              testID="architect-publish"
              label={t("agentPublish")}
              pending={builder.pending === "publish"}
              disabled={Boolean(publish.reason) || Boolean(builder.pending)}
              onPress={() => {
                // What stops the publish is fixed on the last step.
                if (builder.blockers.length > 0 || builder.problems.length > 0)
                  router.push(agentBuilderPaths.step(agent.id, "review"));
                else void builder.publish();
              }}
            />
          </View>
        </View>
      ) : null}
      {publish.reason ? (
        <Text tone="muted" size={13.5}>
          {publish.reason}
        </Text>
      ) : builder.blockers.length > 0 ? (
        <Text tone="muted" size={13.5}>
          {t("architectPublishNeeds", {
            items: builder.blockers
              .map((blocker) => t(`agentBlocker_${blocker.key}`))
              .join("; "),
          })}
        </Text>
      ) : null}
      <LoosenedSheet />
    </View>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1 },
  loader: { marginTop: spacing[10] },
  state: { padding: spacing[4], gap: spacing[4], alignItems: "stretch" },
  bigIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarSmall: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 2,
  },
  talk: {
    padding: spacing[4],
    gap: spacing[3],
    width: "100%",
    maxWidth: 720,
    alignSelf: "center",
  },
  message: { flexDirection: "row", gap: spacing[2], alignItems: "flex-start" },
  mine: { justifyContent: "flex-end" },
  body: { maxWidth: "86%", gap: spacing[2], flexShrink: 1 },
  bodyMine: { alignItems: "flex-end" },
  bubble: {
    borderRadius: radius.bubble,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    gap: spacing[2],
  },
  thinking: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[2],
    borderWidth: StyleSheet.hairlineWidth,
    borderBottomLeftRadius: radius.sm,
  },
  assumptions: { gap: 2 },
  composer: {
    paddingHorizontal: spacing[3],
    paddingTop: spacing[2],
    paddingBottom: spacing[2],
    gap: spacing[1],
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  inputRow: { flexDirection: "row", alignItems: "flex-end", gap: spacing[2] },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 140,
    borderRadius: radius.field,
    borderWidth: 1,
    paddingHorizontal: spacing[3],
    paddingTop: spacing[3] - 1,
    paddingBottom: spacing[3] - 1,
    fontFamily: fonts.regular,
    fontSize: 16,
  },
  over: {
    padding: spacing[4],
    gap: spacing[3],
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  finish: {
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing[4],
    gap: spacing[3],
    marginTop: spacing[2],
  },
  example: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: spacing[3],
    gap: spacing[2],
  },
  finishActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[2],
  },
});
