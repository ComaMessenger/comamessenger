import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { router } from "expo-router";
import {
  Activity,
  ArrowRightLeft,
  BookOpen,
  CalendarSearch,
  Inbox,
  ListChecks,
  MessageCircle,
  Plus,
  ShieldCheck,
  Sparkles,
  UserRoundPlus,
  type LucideIcon,
} from "lucide-react-native";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import {
  agentPlaces,
  agentTask,
  humanStatus,
  pendingByAgent,
  toolLabel,
  type Agent,
  type AgentRecipe,
  type Chat,
} from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { isNetworkError, messageOf } from "@/lib/errors";
import { useTheme } from "@/lib/theme";
import { useMessenger } from "@/messenger/MessengerProvider";
import { useSignedIn } from "@/session/SessionProvider";
import { PersonRow } from "@/people/PersonRow";
import { usePeople } from "@/people/usePeople";
import { useOpenDirect } from "@/people/openDirect";
import { Avatar } from "@/ui/Avatar";
import { BottomSheet } from "@/ui/BottomSheet";
import { Button } from "@/ui/Button";
import { CountBadge } from "@/ui/CountBadge";
import { IconButton } from "@/ui/IconButton";
import { Notice } from "@/ui/Notice";
import { Divider, GroupBody, NavRow, SettingsGroup } from "@/ui/Settings";
import { TabHeader } from "@/ui/TabHeader";
import { Text } from "@/ui/Text";
import {
  agentKeys,
  useAgentAccess,
  useAgents,
  useApprovals,
  useKnownChats,
  useRecipes,
  useRefetchOnFocus,
} from "./data";
import {
  AgentRow,
  AttentionBanner,
  RunRow,
  SectionTitle,
  TextLink,
} from "./parts";
import { agentHref, builderRoutes, canCreateAgent } from "./routes";

/** Icons of the role catalog; Core names them, the client draws them. */
export const recipeIcons: Record<string, LucideIcon> = {
  "list-checks": ListChecks,
  "book-open": BookOpen,
  "user-round-plus": UserRoundPlus,
  "calendar-search": CalendarSearch,
  "arrow-right-left": ArrowRightLeft,
  inbox: Inbox,
};

const recentRuns = 5;

/**
 * Tab «Агенты»: agents of the reader and of the workspace, actions waiting
 * for the reader's decision, recent runs, direct chats with agents and the
 * role catalog. People without agent permissions see the agents they may
 * write to.
 */
export function AgentsHome() {
  const { t } = useTranslation();
  const theme = useTheme();
  const { api, user } = useSignedIn();
  const access = useAgentAccess();
  const { canView, canApprove, canBuild } = access;
  const agents = useAgents();
  const approvals = useApprovals();
  const recipes = useRecipes(canBuild);
  const chats = useKnownChats();
  const runs = useQuery({
    queryKey: agentKeys.workspaceRuns(""),
    queryFn: () => api.workspaceAgentRuns({ limit: recentRuns }),
    enabled: access.canObserve,
    select: (page) => page.runs,
  });
  const [recipe, setRecipe] = useState<AgentRecipe | null>(null);

  const refetchAll = () =>
    Promise.all([
      agents.refetch(),
      canApprove ? approvals.refetch() : null,
      access.canObserve ? runs.refetch() : null,
    ]);
  useRefetchOnFocus(agents.refetch);

  const pending = pendingByAgent(approvals.data ?? []);
  const list = agents.data ?? [];
  const mine = list.filter((agent) => agent.owner_actor_id === user.id);
  const others = list.filter((agent) => agent.owner_actor_id !== user.id);
  const nameOf = (id: string) =>
    list.find((agent) => agent.id === id)?.display_name ?? t("agentUnknown");
  const waiting = approvals.data ?? [];
  const refreshing =
    agents.isRefetching || approvals.isRefetching || runs.isRefetching;

  const agentRows = (items: Agent[], prefix: string) =>
    items.map((agent, index) => (
      <View key={agent.id}>
        {index > 0 && <Divider />}
        <AgentRow
          testID={`${prefix}-${index}`}
          agent={agent}
          status={humanStatus(agent, pending.get(agent.id))}
          task={agentTask(t, agent, recipes.data)}
          places={agentPlaces(t, agent, chats)}
          onPress={() => router.push(agentHref.agent(agent.id) as never)}
        />
      </View>
    ));

  return (
    <View
      testID="agents-home"
      style={[styles.screen, { backgroundColor: theme.canvas }]}
    >
      <TabHeader
        title={t("agentsTitle")}
        trailing={
          canCreateAgent(access) ? (
            <IconButton
              testID="agents-create"
              label={t("agentCreate")}
              variant="soft"
              onPress={() => router.push(agentHref.create() as never)}
              icon={(color) => <Plus size={22} color={color} />}
            />
          ) : null
        }
      />
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void refetchAll()}
            tintColor={theme.muted}
          />
        }
      >
        {canApprove && waiting.length > 0 && (
          <AttentionBanner
            testID="agents-attention"
            title={t("agentApprovalsWaiting", { count: waiting.length })}
            text={
              waiting
                .slice(0, 2)
                .map(
                  (item) =>
                    `${nameOf(item.agent_id)}: ${toolLabel(t, item.tool_name).toLowerCase()}`,
                )
                .join("; ") + (waiting.length > 2 ? "…" : "")
            }
            actionLabel={t("agentApprovalsOpen")}
            onAction={() => router.push(agentHref.approvals as never)}
          />
        )}

        {(canView || canApprove) && (
          <SettingsGroup>
            {canApprove && (
              <ApprovalsRow
                count={waiting.length}
                onPress={() => router.push(agentHref.approvals as never)}
              />
            )}
            {canApprove && canView && <Divider />}
            {canView && (
              <NavRow
                testID="agents-activity"
                icon={Activity}
                label={t("agentNav_activity")}
                hint={t("agentActivityLead")}
                onPress={() => router.push(agentHref.activity() as never)}
              />
            )}
          </SettingsGroup>
        )}

        {canView ? (
          agents.isPending ? (
            <ActivityIndicator style={styles.loader} color={theme.muted} />
          ) : agents.isError && !agents.data ? (
            <Notice
              title={
                isNetworkError(agents.error)
                  ? t("settingsOffline")
                  : t("agentsLoadFailed")
              }
              hint={
                isNetworkError(agents.error)
                  ? t("settingsOfflineHint")
                  : messageOf(agents.error)
              }
              actionLabel={t("retry")}
              onAction={() => void agents.refetch()}
            />
          ) : list.length === 0 ? (
            <Intro canBuild={canBuild} />
          ) : (
            <>
              {mine.length > 0 && (
                <View style={styles.block}>
                  <SectionTitle title={t("agentsMine")} />
                  <SettingsGroup>{agentRows(mine, "agent-mine")}</SettingsGroup>
                </View>
              )}
              {others.length > 0 && (
                <View style={styles.block}>
                  <SectionTitle
                    title={
                      mine.length ? t("agentsOthers") : t("agentCatalogTitle")
                    }
                  />
                  <SettingsGroup>
                    {agentRows(others, "agent-other")}
                  </SettingsGroup>
                </View>
              )}
            </>
          )
        ) : (
          <AvailableAgents />
        )}

        <AgentChats />

        {access.canObserve && (runs.data?.length ?? 0) > 0 && (
          <View style={styles.block}>
            <SectionTitle
              title={t("agentRecentRuns")}
              trailing={
                <TextLink
                  testID="agents-all-activity"
                  label={t("agentAllActivity")}
                  onPress={() => router.push(agentHref.activity() as never)}
                />
              }
            />
            <SettingsGroup>
              {runs.data!.map((run, index) => (
                <View key={run.id}>
                  {index > 0 && <Divider />}
                  <RunRow
                    testID={`agents-run-${index}`}
                    run={run}
                    agent={list.find((agent) => agent.id === run.agent_id)}
                    chats={chats}
                    onPress={() => router.push(agentHref.run(run.id) as never)}
                  />
                </View>
              ))}
            </SettingsGroup>
          </View>
        )}

        {canBuild && (
          <View style={styles.block}>
            <SectionTitle title={t("agentRolesTitle")} />
            <Text tone="muted" size={13.5} style={styles.lead}>
              {t("agentRolesLead")}
            </Text>
            <SettingsGroup>
              {recipes.isPending ? (
                <ActivityIndicator style={styles.inline} color={theme.muted} />
              ) : (
                (recipes.data ?? []).map((item, index) => (
                  <View key={item.id}>
                    {index > 0 && <Divider />}
                    <NavRow
                      testID={`agents-role-${item.id}`}
                      icon={recipeIcons[item.icon] ?? Sparkles}
                      label={item.name}
                      hint={item.summary}
                      onPress={() => setRecipe(item)}
                    />
                  </View>
                ))
              )}
            </SettingsGroup>
          </View>
        )}
      </ScrollView>
      <RecipeSheet
        recipe={recipe}
        canCreate={canCreateAgent(access)}
        onClose={() => setRecipe(null)}
      />
    </View>
  );
}

function ApprovalsRow({ count, onPress }: { count: number; onPress(): void }) {
  const { t } = useTranslation();
  const theme = useTheme();
  return (
    <Pressable
      testID="agents-approvals"
      accessibilityRole="button"
      accessibilityLabel={`${t("agentApprovalsTitle")}, ${t("agentPendingCount", { count })}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.navRow,
        pressed && { backgroundColor: theme.surfaceSelected },
      ]}
    >
      <ShieldCheck size={20} color={theme.muted} />
      <View style={styles.grow}>
        <Text size={16} weight="medium">
          {t("agentApprovalsTitle")}
        </Text>
        <Text tone="muted" size={13.5}>
          {count
            ? t("agentApprovalsWaiting", { count })
            : t("agentApprovalsEmpty")}
        </Text>
      </View>
      {count > 0 ? <CountBadge value={count} /> : null}
    </Pressable>
  );
}

/** No agents yet: what they are and how one appears. */
function Intro({ canBuild }: { canBuild: boolean }) {
  const { t } = useTranslation();
  const theme = useTheme();
  return (
    <View
      testID="agents-intro"
      style={[
        styles.intro,
        { backgroundColor: theme.surface, borderColor: theme.border },
      ]}
    >
      <View style={[styles.introIcon, { backgroundColor: theme.primarySoft }]}>
        <Sparkles size={24} color={theme.primary} />
      </View>
      <Text weight="semibold" size={17}>
        {t("agentIntroTitle")}
      </Text>
      <Text tone="muted" size={14.5}>
        {t("agentIntroText")}
      </Text>
      {canBuild ? (
        <View style={styles.steps}>
          {(
            ["agentIntroStep1", "agentIntroStep2", "agentIntroStep3"] as const
          ).map((key, index) => (
            <Text key={key} size={14.5}>
              {`${index + 1}. ${t(key)}`}
            </Text>
          ))}
          {!builderRoutes.create && (
            <Text tone="muted" size={13.5}>
              {t("agentCreateOnWeb")}
            </Text>
          )}
        </View>
      ) : (
        <Text tone="muted" size={14.5}>
          {t("agentIntroReadOnly")}
        </Text>
      )}
    </View>
  );
}

/**
 * Without agent permissions the workspace list is closed (server rule); the
 * directory still lists agents one may write to.
 */
function AvailableAgents() {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const directory = usePeople({
    query: "",
    filter: "agents",
    locale: i18n.language,
  });
  const direct = useOpenDirect((chatID) => router.push(`/chat/${chatID}`));
  const pages = useRef(0);
  const { complete, loadingMore, loadMore, loading } = directory;
  useEffect(() => {
    if (loading || complete || loadingMore || pages.current >= 10) return;
    pages.current += 1;
    loadMore();
  }, [complete, loadMore, loading, loadingMore]);
  return (
    <View style={styles.block}>
      <SectionTitle title={t("agentsAvailable")} />
      <SettingsGroup>
        {directory.loading ? (
          <ActivityIndicator style={styles.inline} color={theme.muted} />
        ) : directory.failed ? (
          <GroupBody>
            <Notice
              title={t("peopleLoadFailed")}
              actionLabel={t("retry")}
              onAction={directory.refetch}
            />
          </GroupBody>
        ) : directory.people.length === 0 ? (
          <GroupBody>
            <Text tone="muted" size={14}>
              {t("agentsAvailableEmpty")}
            </Text>
          </GroupBody>
        ) : (
          directory.people.map((person, index) => (
            <View key={person.actor_id}>
              {index > 0 && <Divider />}
              <PersonRow
                testID={`agents-available-${index}`}
                person={person}
                presence={undefined}
                onPress={() => void direct.open(person.actor_id)}
              />
            </View>
          ))
        )}
      </SettingsGroup>
      <Text tone="subtle" size={13} style={styles.lead}>
        {t("agentsAvailableHint")}
      </Text>
    </View>
  );
}

/** Direct chats with agents: the reader's own conversations with them. */
function AgentChats() {
  const { t } = useTranslation();
  const { store } = useMessenger();
  const chatMap = useStore(store, (state) => state.chats);
  const unread = useStore(store, (state) => state.unread);
  const chats = useMemo(
    () =>
      Object.values(chatMap)
        .filter(
          (
            chat,
          ): chat is Chat & { direct_peer: NonNullable<Chat["direct_peer"]> } =>
            chat.kind === "direct" && chat.direct_peer?.type === "agent",
        )
        .sort((left, right) =>
          (right.last_message?.created_at ?? right.created_at).localeCompare(
            left.last_message?.created_at ?? left.created_at,
          ),
        ),
    [chatMap],
  );
  if (chats.length === 0) return null;
  return (
    <View style={styles.block}>
      <SectionTitle title={t("agentChatsTitle")} />
      <SettingsGroup>
        {chats.map((chat, index) => (
          <View key={chat.id}>
            {index > 0 && <Divider />}
            <AgentChatRow
              testID={`agents-chat-${index}`}
              chat={chat}
              unread={
                unread.chats.find((item) => item.chat_id === chat.id)
                  ?.unread_count ?? 0
              }
            />
          </View>
        ))}
      </SettingsGroup>
    </View>
  );
}

function AgentChatRow({
  chat,
  unread,
  testID,
}: {
  chat: Chat & { direct_peer: NonNullable<Chat["direct_peer"]> };
  unread: number;
  testID?: string;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const peer = chat.direct_peer;
  const preview = chat.last_message?.body?.trim() || t("agentChatStart");
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={`${peer.display_name}, ${preview}`}
      onPress={() => router.push(`/chat/${chat.id}`)}
      style={({ pressed }) => [
        styles.navRow,
        pressed && { backgroundColor: theme.surfaceSelected },
      ]}
    >
      <Avatar
        name={peer.display_name}
        seed={peer.actor_id}
        actorID={peer.actor_id}
        avatarVersion={peer.avatar_version}
        size={36}
        agent
      />
      <View style={styles.grow}>
        <Text size={16} weight="medium" numberOfLines={1}>
          {peer.display_name}
        </Text>
        <Text tone="muted" size={13.5} numberOfLines={1}>
          {preview}
        </Text>
      </View>
      {unread > 0 ? (
        <CountBadge value={unread} />
      ) : (
        <MessageCircle size={18} color={theme.subtle} />
      )}
    </Pressable>
  );
}

/** A built-in role: what it does, an example and its check examples. */
function RecipeSheet({
  recipe,
  canCreate,
  onClose,
}: {
  recipe: AgentRecipe | null;
  canCreate: boolean;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const Icon = recipe ? (recipeIcons[recipe.icon] ?? Sparkles) : Sparkles;
  return (
    <BottomSheet
      visible={Boolean(recipe)}
      title={recipe?.name}
      onClose={onClose}
      testID="agents-role-sheet"
    >
      {recipe ? (
        <View style={styles.sheet}>
          <View
            style={[styles.roleIcon, { backgroundColor: theme.primarySoft }]}
          >
            <Icon size={22} color={theme.primary} />
          </View>
          <Text size={15.5}>{recipe.summary}</Text>
          <View
            style={[
              styles.quote,
              {
                borderLeftColor: theme.primary,
                backgroundColor: theme.sidebar,
              },
            ]}
          >
            <Text tone="muted" size={14.5}>
              «{recipe.example}»
            </Text>
          </View>
          {recipe.checks.length > 0 && (
            <View style={styles.steps}>
              <Text weight="semibold" size={14}>
                {t("agentCheckExamples")}
              </Text>
              {recipe.checks.map((check) => (
                <Text key={check.prompt} tone="muted" size={14}>
                  • {check.prompt}
                </Text>
              ))}
            </View>
          )}
          {canCreate ? (
            <Button
              testID="agents-role-create"
              label={t("agentCreateFromRole")}
              onPress={() => {
                onClose();
                router.push(agentHref.create(recipe.id) as never);
              }}
            />
          ) : (
            <Text tone="subtle" size={13.5}>
              {t("agentCreateOnWeb")}
            </Text>
          )}
        </View>
      ) : null}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: {
    padding: spacing[4],
    gap: spacing[5],
    paddingBottom: spacing[10],
  },
  loader: { marginTop: spacing[6] },
  inline: { marginVertical: spacing[4] },
  block: { gap: spacing[2] },
  lead: { paddingHorizontal: spacing[1] },
  grow: { flex: 1 },
  navRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[3],
    minHeight: 52,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
  },
  intro: {
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing[4],
    gap: spacing[2],
  },
  introIcon: {
    width: 44,
    height: 44,
    borderRadius: radius.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  steps: { gap: spacing[1] },
  sheet: { gap: spacing[3], paddingBottom: spacing[2] },
  roleIcon: {
    width: 40,
    height: 40,
    borderRadius: radius.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  quote: {
    borderLeftWidth: 3,
    borderRadius: radius.sm,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
  },
});
