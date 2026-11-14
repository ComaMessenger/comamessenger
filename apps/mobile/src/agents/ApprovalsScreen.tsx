import { useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import {
  ChevronDown,
  ChevronUp,
  MessageCircle,
  ShieldCheck,
} from "lucide-react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  approvalText,
  chatName,
  formatDateTime,
  type Agent,
  type AgentToolConfirmation,
  type Chat,
} from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { isNetworkError, messageOf } from "@/lib/errors";
import { useTheme } from "@/lib/theme";
import { useSignedIn } from "@/session/SessionProvider";
import { Avatar } from "@/ui/Avatar";
import { Button } from "@/ui/Button";
import { Notice } from "@/ui/Notice";
import { RowBoundary } from "@/ui/RowBoundary";
import { ScreenHeader } from "@/ui/ScreenHeader";
import { Text } from "@/ui/Text";
import {
  agentKeys,
  useAgentAccess,
  useAgents,
  useApprovals,
  useKnownChats,
  useRefetchOnFocus,
} from "./data";
import { agentHref } from "./routes";

/** Actions agents wait to do until the reader allows them. */
export function ApprovalsScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const { canApprove } = useAgentAccess();
  const approvals = useApprovals();
  const agents = useAgents();
  const chats = useKnownChats();
  useRefetchOnFocus(approvals.refetch);
  const items = approvals.data ?? [];
  return (
    <SafeAreaView
      testID="approvals-screen"
      edges={["bottom"]}
      style={[styles.screen, { backgroundColor: theme.canvas }]}
    >
      <ScreenHeader
        backTestID="approvals-back"
        title={t("agentApprovalsTitle")}
        subtitle={
          items.length
            ? t("agentPendingCount", { count: items.length })
            : undefined
        }
      />
      {!canApprove ? (
        <View style={styles.state}>
          <Notice
            tone="neutral"
            title={t("settingsNoAccess")}
            hint={t("agentApprovalsNoRights")}
          />
        </View>
      ) : approvals.isPending ? (
        <ActivityIndicator style={styles.loader} color={theme.muted} />
      ) : approvals.isError && !approvals.data ? (
        <View style={styles.state}>
          <Notice
            title={
              isNetworkError(approvals.error)
                ? t("settingsOffline")
                : t("agentApprovalsLoadFailed")
            }
            hint={
              isNetworkError(approvals.error)
                ? t("settingsOfflineHint")
                : messageOf(approvals.error)
            }
            actionLabel={t("retry")}
            onAction={() => void approvals.refetch()}
          />
        </View>
      ) : (
        <FlatList
          testID="approvals-list"
          data={items}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={approvals.isRefetching}
              onRefresh={() => void approvals.refetch()}
              tintColor={theme.muted}
            />
          }
          ListHeaderComponent={
            items.length ? (
              <Text tone="muted" size={13.5} style={styles.lead}>
                {t("agentApprovalsLead")}
              </Text>
            ) : null
          }
          renderItem={({ item, index }) => (
            <RowBoundary kind="message" resetKey={item}>
              <ApprovalCard
                testID={`approval-${index}`}
                confirmation={item}
                agent={agents.data?.find((agent) => agent.id === item.agent_id)}
                chats={chats}
              />
            </RowBoundary>
          )}
          ListEmptyComponent={
            <View style={styles.empty}>
              <View
                style={[
                  styles.emptyIcon,
                  { backgroundColor: theme.successSoft },
                ]}
              >
                <ShieldCheck size={26} color={theme.successText} />
              </View>
              <Text weight="semibold" size={17} style={styles.center}>
                {t("agentApprovalsEmpty")}
              </Text>
              <Text tone="muted" size={14.5} style={styles.center}>
                {t("agentApprovalsEmptyHint")}
              </Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

/**
 * One pending action: who asks, what it would do in words, until when, the
 * raw request on demand, and «Разрешить» / «Отклонить».
 */
export function ApprovalCard({
  confirmation,
  agent,
  chats,
  testID,
}: {
  confirmation: AgentToolConfirmation;
  agent: Agent | undefined;
  chats: readonly Chat[];
  testID?: string;
}) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const { api } = useSignedIn();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<"" | "approve" | "deny">("");
  const [error, setError] = useState("");
  const [details, setDetails] = useState(false);
  const text = approvalText(t, confirmation, chats);
  const name = agent?.display_name ?? t("agentUnknown");
  const args = confirmation.arguments as Record<string, unknown>;
  const chat = chats.find((item) => item.id === args.chat_id);

  async function decide(approve: boolean) {
    setPending(approve ? "approve" : "deny");
    setError("");
    try {
      if (approve) await api.approveAgentToolConfirmation(confirmation.id);
      else await api.denyAgentToolConfirmation(confirmation.id);
      // The decided action leaves the queue at once; the rest refetches.
      queryClient.setQueryData<AgentToolConfirmation[]>(
        agentKeys.approvals,
        (items) => items?.filter((item) => item.id !== confirmation.id),
      );
      void queryClient.invalidateQueries({ queryKey: agentKeys.approvals });
      void queryClient.invalidateQueries({ queryKey: agentKeys.runs });
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPending("");
    }
  }

  return (
    <View
      testID={testID}
      style={[
        styles.card,
        { backgroundColor: theme.surface, borderColor: theme.border },
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityHint={t("agentOpenCard")}
        disabled={!agent}
        onPress={() => agent && router.push(agentHref.agent(agent.id) as never)}
        style={styles.head}
      >
        <Avatar
          name={name}
          seed={confirmation.agent_id}
          actorID={confirmation.agent_id}
          avatarVersion={agent?.avatar_version}
          size={32}
          agent
        />
        <Text weight="semibold" size={15} style={styles.grow} numberOfLines={1}>
          {name}
        </Text>
        <Text tone="muted" size={12.5}>
          {formatDateTime(confirmation.requested_at, i18n.language)}
        </Text>
      </Pressable>
      <Text size={15.5} testID={testID ? `${testID}-action` : undefined}>
        {text.action}
      </Text>
      {text.quote ? (
        <View
          style={[
            styles.quote,
            { borderLeftColor: theme.primary, backgroundColor: theme.sidebar },
          ]}
        >
          <Text size={14.5}>{text.quote}</Text>
        </View>
      ) : null}
      <Text tone="muted" size={13}>
        {t("agentApprovalExpires", {
          time: formatDateTime(confirmation.expires_at, i18n.language),
        })}
      </Text>
      <Pressable
        testID={testID ? `${testID}-details` : undefined}
        accessibilityRole="button"
        accessibilityState={{ expanded: details }}
        onPress={() => setDetails((value) => !value)}
        style={styles.details}
        hitSlop={8}
      >
        <Text tone="primary" size={13.5} weight="medium">
          {t("agentApprovalDetails")}
        </Text>
        {details ? (
          <ChevronUp size={16} color={theme.primary} />
        ) : (
          <ChevronDown size={16} color={theme.primary} />
        )}
      </Pressable>
      {details ? (
        <View style={[styles.code, { backgroundColor: theme.sidebar }]}>
          <Text selectable size={12.5} style={styles.mono}>
            {JSON.stringify(confirmation.arguments, null, 2)}
          </Text>
        </View>
      ) : null}
      {error ? <Notice title={t("agentDecisionFailed")} hint={error} /> : null}
      <View style={styles.actions}>
        <View style={styles.grow}>
          <Button
            testID={testID ? `${testID}-approve` : undefined}
            label={t("agentApprove")}
            pending={pending === "approve"}
            disabled={Boolean(pending)}
            onPress={() => void decide(true)}
          />
        </View>
        <View style={styles.grow}>
          <Button
            testID={testID ? `${testID}-deny` : undefined}
            variant="secondary"
            label={t("agentDeny")}
            pending={pending === "deny"}
            disabled={Boolean(pending)}
            onPress={() => void decide(false)}
          />
        </View>
      </View>
      {confirmation.card_message_id && chat ? (
        <Pressable
          testID={testID ? `${testID}-chat` : undefined}
          accessibilityRole="link"
          onPress={() =>
            router.push(
              `/chat/${chat.id}?message=${confirmation.card_message_id}`,
            )
          }
          style={styles.details}
          hitSlop={8}
        >
          <MessageCircle size={16} color={theme.primary} />
          <Text tone="primary" size={13.5} weight="medium">
            {t("agentApprovalOpenChat", { chat: chatName(chat) })}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  state: { padding: spacing[4] },
  loader: { marginTop: spacing[10] },
  list: {
    padding: spacing[4],
    gap: spacing[3],
    paddingBottom: spacing[10],
    flexGrow: 1,
  },
  lead: { paddingHorizontal: spacing[1] },
  card: {
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing[4],
    gap: spacing[2],
  },
  head: { flexDirection: "row", alignItems: "center", gap: spacing[2] },
  grow: { flex: 1 },
  quote: {
    borderLeftWidth: 3,
    borderRadius: radius.sm,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
  },
  details: { flexDirection: "row", alignItems: "center", gap: 4 },
  code: { borderRadius: radius.md, padding: spacing[3] },
  mono: { fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }) },
  actions: { flexDirection: "row", gap: spacing[2], marginTop: spacing[1] },
  empty: {
    paddingHorizontal: spacing[6],
    paddingTop: spacing[12],
    gap: spacing[2],
    alignItems: "center",
  },
  emptyIcon: {
    width: 56,
    height: 56,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 6,
  },
  center: { textAlign: "center" },
});
