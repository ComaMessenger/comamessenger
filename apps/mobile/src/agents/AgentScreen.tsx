import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import {
  Activity,
  FlaskConical,
  MessageCircle,
  Pause,
  Pencil,
  Play,
  Plus,
  ShieldCheck,
  UserRound,
} from "lucide-react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  APIError,
  agentTask,
  chatName,
  chatTriggersOf,
  describeActions,
  describeReads,
  describeTriggers,
  humanStatus,
  pendingByAgent,
  recipeOf,
  type ActorPage,
  type ActorSummary,
  type Agent,
  type Chat,
} from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { isNetworkError, messageOf } from "@/lib/errors";
import { useTheme } from "@/lib/theme";
import { useMessenger } from "@/messenger/MessengerProvider";
import { useSignedIn } from "@/session/SessionProvider";
import { directoryKey, findActor } from "@/people/usePeople";
import { useOpenDirect } from "@/people/openDirect";
import { Avatar } from "@/ui/Avatar";
import { Button } from "@/ui/Button";
import { IconButton } from "@/ui/IconButton";
import { Notice } from "@/ui/Notice";
import { PickerSheet } from "@/ui/PickerSheet";
import { ScreenHeader } from "@/ui/ScreenHeader";
import {
  ActionRow,
  Divider,
  GroupBody,
  InfoRow,
  NavRow,
  SettingsGroup,
} from "@/ui/Settings";
import { Text } from "@/ui/Text";
import {
  agentKeys,
  useAgent,
  useAgentAccess,
  useApprovals,
  useKnownChats,
  useRecipes,
} from "./data";
import { AgentStatusPill, RunRow, SectionTitle, TextLink } from "./parts";
import { agentHref, canEditAgent } from "./routes";

const lastRuns = 8;

/**
 * Card of an agent: what it does and can do, where it works, who owns it,
 * its status and last runs; write to it, pause or resume, add it to a chat
 * and check it — each by the reader's rights, as on the web.
 */
export function AgentScreen({ agentID }: { agentID: string }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const access = useAgentAccess();
  const { agent, query } = useAgent(agentID);
  const loading = query.isPending && access.canView;
  return (
    <SafeAreaView
      testID="agent-screen"
      edges={["bottom"]}
      style={[styles.screen, { backgroundColor: theme.canvas }]}
    >
      <ScreenHeader
        backTestID="agent-back"
        title={agent?.display_name ?? t("agentProfile")}
        trailing={
          agent && canEditAgent(access) ? (
            <IconButton
              testID="agent-edit"
              label={t("agentEdit")}
              onPress={() => router.push(agentHref.edit(agent.id) as never)}
              icon={(color) => <Pencil size={20} color={color} />}
            />
          ) : null
        }
      />
      {!access.canView ? (
        <View style={styles.state}>
          <Notice
            tone="neutral"
            title={t("settingsNoAccess")}
            hint={t("agentNoAccessHint")}
          />
        </View>
      ) : loading ? (
        <ActivityIndicator style={styles.loader} color={theme.muted} />
      ) : query.isError && !query.data ? (
        <View style={styles.state}>
          <Notice
            title={
              isNetworkError(query.error)
                ? t("settingsOffline")
                : t("agentsLoadFailed")
            }
            hint={
              isNetworkError(query.error)
                ? t("settingsOfflineHint")
                : messageOf(query.error)
            }
            actionLabel={t("retry")}
            onAction={() => void query.refetch()}
          />
        </View>
      ) : !agent ? (
        <View style={styles.state}>
          <Notice
            tone="neutral"
            title={t("agentNotFound")}
            hint={t("agentNotFoundHint")}
          />
        </View>
      ) : (
        <AgentDetails agent={agent} refetch={query.refetch} />
      )}
    </SafeAreaView>
  );
}

function AgentDetails({
  agent,
  refetch,
}: {
  agent: Agent;
  refetch(): Promise<unknown>;
}) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const { api, user } = useSignedIn();
  const { store } = useMessenger();
  const queryClient = useQueryClient();
  const access = useAgentAccess();
  const { canBuild, canPublish, canApprove, canView } = access;
  const chats = useKnownChats();
  const recipes = useRecipes();
  const approvals = useApprovals();
  const pending = pendingByAgent(approvals.data ?? []).get(agent.id) ?? 0;
  const status = humanStatus(agent, pending);
  const recipe = recipeOf(recipes.data, agent);
  const direct = useOpenDirect((chatID) => router.push(`/chat/${chatID}`));
  const [busy, setBusy] = useState<"" | "pause" | "resume" | "chat">("");
  const [notice, setNotice] = useState<{
    tone: "success" | "danger" | "neutral";
    title: string;
    hint?: string;
  } | null>(null);
  const [picking, setPicking] = useState(false);

  const triggers = useQuery({
    queryKey: agentKeys.triggers(agent.id),
    queryFn: () => api.agentTriggers(agent.id),
    enabled: canView,
  });
  const runs = useQuery({
    queryKey: agentKeys.agentRuns(agent.id),
    queryFn: () => api.agentRuns(agent.id),
    enabled: canView,
    refetchInterval: 30_000,
  });
  const owner = useQuery({
    queryKey: ["actor", agent.owner_actor_id],
    queryFn: () => {
      const pages =
        queryClient.getQueryData<{ pages: ActorPage[] }>(directoryKey)?.pages ??
        [];
      const known: ActorSummary[] = [
        ...pages.flatMap((page) => page.actors),
        ...Object.values(store.getState().chats).flatMap((chat) =>
          chat.direct_peer ? [chat.direct_peer] : [],
        ),
      ];
      return findActor(api, agent.owner_actor_id, known);
    },
    enabled: agent.owner_actor_id !== user.id,
    staleTime: 5 * 60_000,
  });

  const described = {
    scopes: agent.allowed_scopes,
    knowledge_collection_count: agent.knowledge_collection_ids?.length ?? 0,
  };
  const reads = describeReads(described, t);
  const actions = describeActions(described, t);
  const starts = triggers.data
    ? describeTriggers(
        { triggers: chatTriggersOf(triggers.data) },
        t,
        i18n.language,
      )
    : [];
  const places = agent.chat_ids.map((id) => ({
    id,
    chat: chats.find((chat) => chat.id === id),
  }));
  const addable = chats.filter(
    (chat) =>
      !agent.chat_ids.includes(chat.id) &&
      (chat.kind !== "direct" || chat.direct_peer?.actor_id === agent.id),
  );
  const ownerName =
    agent.owner_actor_id === user.id
      ? t("agentOwnerYou")
      : (owner.data?.display_name ??
        (owner.isPending ? "…" : t("agentUnknown")));
  const blockers = agent.readiness.blockers;

  async function act(kind: "pause" | "resume") {
    setBusy(kind);
    setNotice(null);
    try {
      if (kind === "pause") await api.pauseAgent(agent.id);
      else await api.resumeAgent(agent.id);
      await refetch();
      setNotice({
        tone: "success",
        title:
          kind === "pause" ? t("agentPausedNotice") : t("agentResumedNotice"),
      });
    } catch (cause) {
      setNotice({
        tone: "danger",
        title:
          cause instanceof APIError && cause.code === "agent_not_ready"
            ? t("acNotReady")
            : t("actionFailed"),
        hint: messageOf(cause),
      });
    } finally {
      setBusy("");
    }
  }

  /*
   * Adding a chat changes the draft, as the builder's «Где работает» does.
   * An agent whose published version is current is published again right
   * away when the reader may publish; otherwise the change waits in the
   * draft for whoever publishes.
   */
  async function addToChat(chat: Chat) {
    setBusy("chat");
    setNotice(null);
    const read = [
      ...new Set([...(agent.read_chat_ids ?? agent.chat_ids), chat.id]),
    ];
    const write = [
      ...new Set([...(agent.write_chat_ids ?? agent.chat_ids), chat.id]),
    ];
    try {
      await api.updateAgent(agent.id, {
        chat_ids: [...new Set([...read, ...write])].sort(),
        read_chat_ids: read,
        write_chat_ids: write,
      });
      const publish =
        canPublish &&
        agent.published_version != null &&
        !agent.has_unpublished_changes;
      if (publish) await api.publishAgent(agent.id);
      await refetch();
      setNotice({
        tone: "success",
        title: t("agentAddedToChat", { chat: chatName(chat) }),
        hint: publish ? undefined : t("agentAddedToDraft"),
      });
    } catch (cause) {
      setNotice({
        tone: "danger",
        title: t("agentAddToChatFailed"),
        hint: messageOf(cause),
      });
    } finally {
      setBusy("");
    }
  }

  const runList = runs.data?.runs.slice(0, lastRuns) ?? [];

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={false}
          onRefresh={() =>
            void Promise.all([refetch(), runs.refetch(), triggers.refetch()])
          }
          tintColor={theme.muted}
        />
      }
    >
      <View
        style={[
          styles.hero,
          { backgroundColor: theme.surface, borderColor: theme.border },
        ]}
      >
        <Avatar
          name={agent.display_name}
          seed={agent.id}
          actorID={agent.id}
          avatarVersion={agent.avatar_version}
          size={64}
          agent
        />
        <Text weight="bold" size={20} style={styles.center}>
          {agent.display_name}
        </Text>
        <Text tone="muted" size={14}>
          @{agent.handle}
        </Text>
        <AgentStatusPill testID="agent-status" status={status} withReason />
        <Text size={15} style={styles.center}>
          {agentTask(t, agent, recipes.data)}
        </Text>
        <View style={styles.primary}>
          <Button
            testID="agent-write"
            label={t("agentWrite")}
            pending={direct.opening === agent.id}
            onPress={() => void direct.open(agent.id)}
          />
        </View>
      </View>

      {notice && (
        <Notice tone={notice.tone} title={notice.title} hint={notice.hint} />
      )}

      {canApprove && pending > 0 && (
        <SettingsGroup>
          <NavRow
            testID="agent-approvals"
            icon={ShieldCheck}
            label={t("agentApprovalsWaiting", { count: pending })}
            onPress={() => router.push(agentHref.approvals as never)}
          />
        </SettingsGroup>
      )}

      {(canBuild ||
        (canPublish &&
          ["active", "paused"].includes(agent.operational_status))) && (
        <SettingsGroup title={t("agentManage")}>
          {canPublish && agent.operational_status === "active" && (
            <ActionRow
              testID="agent-pause"
              icon={Pause}
              tone="default"
              label={t("agentPause")}
              pending={busy === "pause"}
              disabled={Boolean(busy)}
              onPress={() => void act("pause")}
            />
          )}
          {canPublish && agent.operational_status === "paused" && (
            <ActionRow
              testID="agent-resume"
              icon={Play}
              tone="default"
              label={t("agentResume")}
              hint={blockers.length ? t("agentResumeBlocked") : undefined}
              pending={busy === "resume"}
              disabled={Boolean(busy) || blockers.length > 0}
              onPress={() => void act("resume")}
            />
          )}
          {canBuild && (
            <>
              {canPublish &&
                ["active", "paused"].includes(agent.operational_status) && (
                  <Divider />
                )}
              <ActionRow
                testID="agent-add-chat"
                icon={Plus}
                tone="default"
                label={t("agentAddToChat")}
                pending={busy === "chat"}
                disabled={Boolean(busy) || addable.length === 0}
                onPress={() => setPicking(true)}
              />
              <Divider />
              <NavRow
                testID="agent-check"
                icon={FlaskConical}
                label={t("agentCheckTitle")}
                hint={t("agentCheckShort")}
                onPress={() => router.push(agentHref.check(agent.id) as never)}
              />
            </>
          )}
        </SettingsGroup>
      )}

      <SettingsGroup title={t("agentCanTitle")}>
        <InfoBlock
          label={t("acStarts")}
          lines={triggers.isPending ? ["…"] : starts}
        />
        {reads.length > 0 && (
          <>
            <Divider />
            <InfoBlock label={t("acReads")} lines={reads} />
          </>
        )}
        <Divider />
        <InfoBlock label={t("acDoes")} lines={actions} />
      </SettingsGroup>

      <SettingsGroup title={t("agentPlacesTitle")}>
        {places.length === 0 ? (
          <GroupBody>
            <Text tone="muted" size={14}>
              {t("agentPlacesNone")}
            </Text>
          </GroupBody>
        ) : (
          places.map(({ id, chat }, index) => (
            <View key={id}>
              {index > 0 && <Divider />}
              {chat ? (
                <NavRow
                  testID={`agent-place-${index}`}
                  icon={MessageCircle}
                  label={chatName(chat)}
                  onPress={() => router.push(`/chat/${chat.id}`)}
                />
              ) : (
                <InfoRow label={t("agentChatHidden")} value="" />
              )}
            </View>
          ))
        )}
      </SettingsGroup>

      <SettingsGroup title={t("agentAbout")}>
        <NavRow
          testID="agent-owner"
          icon={UserRound}
          label={t("agentOwner")}
          value={ownerName}
          disabled={agent.owner_actor_id === user.id}
          onPress={() => router.push(`/people/${agent.owner_actor_id}`)}
        />
        <Divider />
        <InfoRow
          label={t("agentVersion")}
          value={
            agent.published_version
              ? t("agentVersionShort", { version: agent.published_version })
              : t("agentNotPublished")
          }
        />
        {recipe ? (
          <>
            <Divider />
            <InfoRow label={t("agentRole")} value={recipe.name} />
          </>
        ) : null}
        {agent.model ? (
          <>
            <Divider />
            <InfoRow label={t("agentModel")} value={agent.model} />
          </>
        ) : null}
      </SettingsGroup>

      <View style={styles.block}>
        <SectionTitle
          title={t("agentRecentRuns")}
          trailing={
            <TextLink
              testID="agent-all-activity"
              label={t("agentAllActivity")}
              onPress={() => router.push(agentHref.activity(agent.id) as never)}
            />
          }
        />
        <SettingsGroup>
          {runs.isPending ? (
            <ActivityIndicator style={styles.inline} color={theme.muted} />
          ) : runList.length === 0 ? (
            <GroupBody>
              <Text tone="muted" size={14}>
                {t("agentFeedEmpty")}
              </Text>
            </GroupBody>
          ) : (
            runList.map((run, index) => (
              <View key={run.id}>
                {index > 0 && <Divider />}
                <RunRow
                  testID={`agent-run-${index}`}
                  run={run}
                  agent={agent}
                  chats={chats}
                  onPress={() => router.push(agentHref.run(run.id) as never)}
                />
              </View>
            ))
          )}
        </SettingsGroup>
      </View>

      <SettingsGroup>
        <NavRow
          icon={Activity}
          label={t("agentAllActivity")}
          onPress={() => router.push(agentHref.activity(agent.id) as never)}
        />
      </SettingsGroup>

      <PickerSheet<string>
        testID="agent-chat-picker"
        visible={picking}
        title={t("agentAddToChat")}
        value=""
        options={addable.map((chat) => ({
          value: chat.id,
          label: chatName(chat),
        }))}
        onSelect={(id) => {
          const chat = addable.find((item) => item.id === id);
          if (!chat) return;
          Alert.alert(
            t("agentAddToChatConfirm", {
              agent: agent.display_name,
              chat: chatName(chat),
            }),
            t("agentAddToChatHint"),
            [
              { text: t("cancel"), style: "cancel" },
              {
                text: t("agentAddToChat"),
                onPress: () => void addToChat(chat),
              },
            ],
          );
        }}
        onClose={() => setPicking(false)}
      />
    </ScrollView>
  );
}

function InfoBlock({ label, lines }: { label: string; lines: string[] }) {
  return (
    <View accessible style={styles.info}>
      <Text tone="muted" size={13}>
        {label}
      </Text>
      {lines.map((line) => (
        <Text key={line} size={15}>
          {line}
        </Text>
      ))}
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
    alignItems: "center",
    gap: spacing[2],
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing[4],
  },
  center: { textAlign: "center" },
  primary: { alignSelf: "stretch", marginTop: spacing[2] },
  block: { gap: spacing[2] },
  info: {
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    gap: 2,
  },
});
