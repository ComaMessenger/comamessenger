import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { CalendarClock, ListChecks, ShieldCheck } from "lucide-react-native";
import { useInfiniteQuery, useQueries, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  chatName,
  formatDateTime,
  formatSpending,
  runFailed,
  runFinished,
  todayActivity,
  type AgentRun,
} from "@comamessenger/core";
import { spacing } from "@comamessenger/tokens";
import { isNetworkError, messageOf } from "@/lib/errors";
import { useTheme } from "@/lib/theme";
import { useSignedIn } from "@/session/SessionProvider";
import { Button } from "@/ui/Button";
import { Notice } from "@/ui/Notice";
import { PickerSheet } from "@/ui/PickerSheet";
import { RowBoundary } from "@/ui/RowBoundary";
import { ScreenHeader } from "@/ui/ScreenHeader";
import { Divider, NavRow, SettingsGroup } from "@/ui/Settings";
import { TabChip } from "@/ui/TabChip";
import { Text } from "@/ui/Text";
import {
  agentKeys,
  useAgentAccess,
  useAgents,
  useApprovals,
  useKnownChats,
  useRefetchOnFocus,
} from "./data";
import { RunRow, SectionTitle, StatTile } from "./parts";
import { agentHref } from "./routes";

/**
 * Without agents.observe the feed falls back to reading the runs of at most
 * this many agents one by one; observers read the workspace feed page by
 * page (as on the web).
 */
const feedAgents = 20;
const feedPage = 40;

type Outcome = "all" | "failed" | "working";

/**
 * What agents did, in words, with the figures of the day, open collections
 * and follow-ups, filtered by agent and by outcome.
 */
export function ActivityScreen({ initialAgentID }: { initialAgentID: string }) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const { api } = useSignedIn();
  const access = useAgentAccess();
  const { canApprove, canObserve, canView } = access;
  const [agentID, setAgentID] = useState(initialAgentID);
  const [outcome, setOutcome] = useState<Outcome>("all");
  const [picking, setPicking] = useState(false);
  const agents = useAgents();
  const approvals = useApprovals();
  const chats = useKnownChats();
  const list = agents.data ?? [];
  const shown = agentID
    ? list.filter((agent) => agent.id === agentID)
    : list.slice(0, feedAgents);

  const workspaceRuns = useInfiniteQuery({
    queryKey: agentKeys.workspaceRuns(agentID),
    queryFn: ({ pageParam }) =>
      api.workspaceAgentRuns({
        cursor: pageParam || undefined,
        limit: feedPage,
        agentID: agentID || undefined,
      }),
    initialPageParam: "",
    getNextPageParam: (page) => page.next_cursor || undefined,
    enabled: canObserve,
    refetchInterval: 30_000,
  });
  const runs = useQueries({
    queries: shown.map((agent) => ({
      queryKey: agentKeys.agentRuns(agent.id),
      queryFn: () => api.agentRuns(agent.id),
      enabled: canView && !canObserve,
      refetchInterval: 30_000,
    })),
  });
  const collections = useQuery({
    queryKey: agentKeys.collections(agentID),
    queryFn: () => api.agentResponseCollections("open", agentID || undefined),
    enabled: canObserve,
    refetchInterval: 30_000,
  });
  const followups = useQuery({
    queryKey: agentKeys.followups(agentID),
    queryFn: () => api.agentFollowups("pending", agentID || undefined),
    enabled: canObserve,
    refetchInterval: 30_000,
  });
  useRefetchOnFocus(canObserve ? workspaceRuns.refetch : agents.refetch);

  const nameOf = (id: string) =>
    list.find((agent) => agent.id === id)?.display_name ?? t("agentUnknown");
  const chatOf = (id: string) => {
    const chat = chats.find((item) => item.id === id);
    return chat ? chatName(chat) : t("agentChatHidden");
  };
  const feed: AgentRun[] = useMemo(
    () =>
      canObserve
        ? (workspaceRuns.data?.pages.flatMap((page) => page.runs) ?? [])
        : runs
            .flatMap((query) => query.data?.runs ?? [])
            .sort(
              (left, right) =>
                new Date(right.created_at).getTime() -
                new Date(left.created_at).getTime(),
            )
            .slice(0, feedPage),
    [canObserve, runs, workspaceRuns.data],
  );
  const visible = feed.filter((run) =>
    outcome === "failed"
      ? runFailed(run)
      : outcome === "working"
        ? !runFinished(run)
        : true,
  );
  const feedLoading = canObserve
    ? workspaceRuns.isPending
    : agents.isPending || runs.some((query) => query.isPending);
  const feedError = canObserve
    ? workspaceRuns.isError && !workspaceRuns.data
      ? workspaceRuns.error
      : null
    : agents.isError && !agents.data
      ? agents.error
      : null;
  const pendingApprovals = (approvals.data ?? []).filter(
    (item) => !agentID || item.agent_id === agentID,
  );
  const stats = todayActivity(feed);

  const header = (
    <View style={styles.header}>
      <Text tone="muted" size={14}>
        {t("agentActivityLead")}
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chips}
      >
        {list.length > 1 && (
          <TabChip
            testID="activity-agent-filter"
            label={`${agentID ? nameOf(agentID) : t("agentActivityAll")} ▾`}
            selected={Boolean(agentID)}
            accessibilityLabel={`${t("agentActivityFilter")}: ${agentID ? nameOf(agentID) : t("agentActivityAll")}`}
            onPress={() => setPicking(true)}
          />
        )}
        {(["all", "failed", "working"] as const).map((value) => (
          <TabChip
            key={value}
            testID={`activity-outcome-${value}`}
            label={t(`agentOutcome_${value}`)}
            selected={outcome === value}
            onPress={() => setOutcome(value)}
          />
        ))}
      </ScrollView>
      <View style={styles.stats}>
        <StatTile
          testID="activity-stat-runs"
          value={String(stats.runs.length)}
          label={t("agentStatRuns")}
        />
        {canApprove && (
          <StatTile
            value={String(pendingApprovals.length)}
            label={t("agentStatApprovals")}
          />
        )}
        <StatTile
          value={String(stats.failures)}
          label={t("agentStatFailures")}
          danger={stats.failures > 0}
        />
        <StatTile
          value={formatSpending(stats.spending, i18n.language)}
          label={t("agentStatSpent")}
        />
      </View>
      {canApprove && (
        <SettingsGroup>
          <NavRow
            testID="activity-approvals"
            icon={ShieldCheck}
            label={t("agentApprovalsTitle")}
            value={String(pendingApprovals.length)}
            onPress={() => router.push(agentHref.approvals as never)}
          />
        </SettingsGroup>
      )}
      {canObserve && (collections.data?.length ?? 0) > 0 && (
        <SettingsGroup title={t("agentCollectionsTitle")}>
          {collections.data!.map((collection, index) => (
            <View key={collection.id}>
              {index > 0 && <Divider />}
              <View accessible style={styles.line}>
                <ListChecks size={18} color={theme.muted} />
                <View style={styles.grow}>
                  <Text size={15} weight="medium">
                    {t("agentCollectionLine", {
                      agent: nameOf(collection.agent_id),
                      chat: chatOf(collection.chat_id),
                    })}
                  </Text>
                  <Text tone="muted" size={13}>
                    {[
                      t("agentCollectionCount", {
                        responded: collection.responded_count,
                        expected: collection.expected_count,
                      }),
                      t("agentCollectionDeadline", {
                        time: formatDateTime(
                          collection.deadline_at,
                          i18n.language,
                        ),
                      }),
                      collection.reminders_sent > 0
                        ? t("agentCollectionReminders", {
                            count: collection.reminders_sent,
                          })
                        : "",
                      collection.note,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </Text>
                </View>
              </View>
            </View>
          ))}
        </SettingsGroup>
      )}
      {canObserve && (followups.data?.length ?? 0) > 0 && (
        <SettingsGroup title={t("agentFollowupsTitle")}>
          {followups.data!.map((followup, index) => (
            <View key={followup.id}>
              {index > 0 && <Divider />}
              <View accessible style={styles.line}>
                <CalendarClock size={18} color={theme.muted} />
                <View style={styles.grow}>
                  <Text size={15} weight="medium">
                    {t("agentFollowupLine", {
                      agent: nameOf(followup.agent_id),
                      time: formatDateTime(followup.due_at, i18n.language),
                      chat: chatOf(followup.chat_id),
                    })}
                  </Text>
                  {followup.note ? (
                    <Text tone="muted" size={13}>
                      {followup.note}
                    </Text>
                  ) : null}
                </View>
              </View>
            </View>
          ))}
        </SettingsGroup>
      )}
      <SectionTitle title={t("agentFeedTitle")} />
    </View>
  );

  return (
    <SafeAreaView
      testID="activity-screen"
      edges={["bottom"]}
      style={[styles.screen, { backgroundColor: theme.canvas }]}
    >
      <ScreenHeader
        backTestID="activity-back"
        title={t("agentActivityTitle")}
      />
      {!canView ? (
        <View style={styles.state}>
          <Notice
            tone="neutral"
            title={t("settingsNoAccess")}
            hint={t("agentNoAccessHint")}
          />
        </View>
      ) : (
        <FlatList
          testID="activity-list"
          data={feedLoading || feedError ? [] : visible}
          keyExtractor={(run) => run.id}
          contentContainerStyle={styles.list}
          ListHeaderComponent={header}
          refreshControl={
            <RefreshControl
              refreshing={
                workspaceRuns.isRefetching && !workspaceRuns.isFetchingNextPage
              }
              onRefresh={() =>
                void Promise.all([
                  canObserve ? workspaceRuns.refetch() : agents.refetch(),
                  ...runs.map((query) => query.refetch()),
                  canApprove ? approvals.refetch() : null,
                  canObserve ? collections.refetch() : null,
                  canObserve ? followups.refetch() : null,
                ])
              }
              tintColor={theme.muted}
            />
          }
          renderItem={({ item, index }) => (
            <RowBoundary kind="message" resetKey={item}>
              <View
                style={[
                  styles.row,
                  {
                    backgroundColor: theme.surface,
                    borderColor: theme.border,
                  },
                  index === 0 && styles.first,
                  index === visible.length - 1 && styles.last,
                ]}
              >
                {index > 0 && <Divider />}
                <RunRow
                  testID={`activity-run-${index}`}
                  run={item}
                  agent={list.find((agent) => agent.id === item.agent_id)}
                  chats={chats}
                  onPress={() => router.push(agentHref.run(item.id) as never)}
                />
              </View>
            </RowBoundary>
          )}
          ListEmptyComponent={
            feedLoading ? (
              <ActivityIndicator style={styles.loader} color={theme.muted} />
            ) : feedError ? (
              <Notice
                title={
                  isNetworkError(feedError)
                    ? t("settingsOffline")
                    : t("agentActivityLoadFailed")
                }
                hint={
                  isNetworkError(feedError)
                    ? t("settingsOfflineHint")
                    : messageOf(feedError)
                }
                actionLabel={t("retry")}
                onAction={() =>
                  void (canObserve ? workspaceRuns.refetch() : agents.refetch())
                }
              />
            ) : (
              <Text tone="muted" size={14} style={styles.empty}>
                {outcome === "all"
                  ? t("agentFeedEmpty")
                  : t("agentFeedEmptyFiltered")}
              </Text>
            )
          }
          ListFooterComponent={
            canObserve && workspaceRuns.hasNextPage ? (
              <View style={styles.more}>
                <Button
                  testID="activity-more"
                  variant="ghost"
                  label={t("agentFeedMore")}
                  pending={workspaceRuns.isFetchingNextPage}
                  onPress={() => void workspaceRuns.fetchNextPage()}
                />
              </View>
            ) : null
          }
        />
      )}
      <PickerSheet<string>
        testID="activity-agent-picker"
        visible={picking}
        title={t("agentActivityFilter")}
        value={agentID || "all"}
        options={[
          { value: "all", label: t("agentActivityAll") },
          ...list.map((agent) => ({
            value: agent.id,
            label: agent.display_name,
          })),
        ]}
        onSelect={(value) => setAgentID(value === "all" ? "" : value)}
        onClose={() => setPicking(false)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  state: { padding: spacing[4] },
  loader: { marginTop: spacing[6] },
  list: { padding: spacing[4], paddingBottom: spacing[10] },
  header: { gap: spacing[4], marginBottom: spacing[2] },
  chips: { gap: 6 },
  stats: { flexDirection: "row", flexWrap: "wrap", gap: spacing[2] },
  grow: { flex: 1 },
  line: {
    flexDirection: "row",
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
  },
  row: { borderLeftWidth: 1, borderRightWidth: 1, overflow: "hidden" },
  first: {
    borderTopWidth: 1,
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
  },
  last: {
    borderBottomWidth: 1,
    borderBottomLeftRadius: 12,
    borderBottomRightRadius: 12,
  },
  empty: { paddingHorizontal: spacing[1], paddingTop: spacing[2] },
  more: { marginTop: spacing[3] },
});
