import { useMemo } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import {
  chatAvatarSource,
  type ActorPage,
  type ActorSummary,
  type Chat,
} from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { useMessenger } from "@/messenger/MessengerProvider";
import { withCache } from "@/messenger/cache";
import { useSignedIn } from "@/session/SessionProvider";
import { ChatAvatar } from "@/chats/ChatAvatar";
import { chatTitle } from "@/chats/ChatRow";
import { Button } from "@/ui/Button";
import { Notice } from "@/ui/Notice";
import { ScreenHeader } from "@/ui/ScreenHeader";
import { Text } from "@/ui/Text";
import { useAgentAccess } from "@/agents/data";
import { agentHref } from "@/agents/routes";
import { useOpenDirect } from "./openDirect";
import { AgentTag, presenceLabelKey } from "./PersonRow";
import { directoryKey, findActor } from "./usePeople";

const sharedChatLimit = 40;

/** Group chats and channels the reader shares with the actor; members lists are cached. */
function useSharedChats(actorID: string) {
  const { api } = useSignedIn();
  const { store } = useMessenger();
  const chatMap = useStore(store, (state) => state.chats);
  const groups = useMemo(
    () =>
      Object.values(chatMap)
        .filter((chat) => chat.kind !== "direct")
        .slice(0, sharedChatLimit),
    [chatMap],
  );
  const results = useQueries({
    queries: groups.map((chat) => ({
      queryKey: ["members", chat.id],
      queryFn: () =>
        withCache(`members:${chat.id}`, () => api.members(chat.id)),
      staleTime: 5 * 60_000,
    })),
  });
  const loading = results.some((result) => result.isLoading);
  const shared: Chat[] = groups.filter((_, index) =>
    results[index]?.data?.some((member) => member.actor_id === actorID),
  );
  return { shared, loading };
}

/** Card of a person or an agent: who they are, their status and «Написать». */
export function PersonScreen({ actorID }: { actorID: string }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { api, user } = useSignedIn();
  const { store } = useMessenger();
  const queryClient = useQueryClient();
  const presence = useStore(store, (state) => state.presence[actorID]);
  const actor = useQuery({
    queryKey: ["actor", actorID],
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
      return findActor(api, actorID, known);
    },
    staleTime: 5 * 60_000,
  });
  const { shared, loading } = useSharedChats(actorID);
  const direct = useOpenDirect((chatID) => router.push(`/chat/${chatID}`));
  const person = actor.data;
  const agent = person?.type === "agent";
  const self = actorID === user.id;
  const { canView: canViewAgents } = useAgentAccess();

  return (
    <SafeAreaView
      testID="person"
      edges={["bottom"]}
      style={[styles.screen, { backgroundColor: theme.canvas }]}
    >
      <ScreenHeader
        backTestID="person-back"
        title={agent ? t("agentProfile") : t("personProfile")}
      />
      {actor.isLoading ? (
        <ActivityIndicator style={styles.loader} color={theme.muted} />
      ) : actor.isError ? (
        <View style={styles.content}>
          <Notice
            title={t("peopleLoadFailed")}
            actionLabel={t("retry")}
            onAction={() => void actor.refetch()}
          />
        </View>
      ) : !person ? (
        <View style={styles.content}>
          <Notice tone="neutral" title={t("personNotFound")} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <View
            style={[
              styles.card,
              { backgroundColor: theme.surface, borderColor: theme.border },
            ]}
          >
            <ChatAvatar
              name={person.display_name}
              seed={person.actor_id}
              actorID={person.actor_id}
              avatarVersion={person.avatar_version}
              size={88}
              shape="circle"
              agent={agent}
              online={!agent && presence === "online"}
              ringColor={theme.surface}
            />
            <View style={styles.nameLine}>
              <Text
                accessibilityRole="header"
                weight="bold"
                size={21}
                style={styles.center}
              >
                {person.display_name}
              </Text>
              {agent ? <AgentTag /> : null}
            </View>
            <Text tone="muted" size={14.5} style={styles.center}>
              {[
                `@${person.handle}`,
                person.title,
                agent ? null : t(presenceLabelKey(presence)),
              ]
                .filter(Boolean)
                .join(" · ")}
            </Text>
            {person.status_text || person.status_emoji ? (
              <View
                style={[
                  styles.status,
                  { backgroundColor: theme.surfaceSelected },
                ]}
              >
                <Text size={14}>
                  {[person.status_emoji, person.status_text]
                    .filter(Boolean)
                    .join(" ")}
                </Text>
              </View>
            ) : null}
            {!self ? (
              <View style={styles.action}>
                <Button
                  testID="person-write"
                  label={t("writeMessage")}
                  pending={direct.opening === person.actor_id}
                  onPress={() => void direct.open(person.actor_id)}
                />
                {agent && canViewAgents ? (
                  <Button
                    testID="person-agent-card"
                    variant="secondary"
                    label={t("agentOpenCardButton")}
                    onPress={() =>
                      router.push(agentHref.agent(person.actor_id) as never)
                    }
                  />
                ) : null}
              </View>
            ) : null}
          </View>

          {person.about ? (
            <View
              style={[
                styles.section,
                { backgroundColor: theme.surface, borderColor: theme.border },
              ]}
            >
              <Text tone="muted" size={13} weight="semibold">
                {t("personAbout")}
              </Text>
              <Text size={15}>{person.about}</Text>
            </View>
          ) : null}

          {!self ? (
            <View
              style={[
                styles.section,
                { backgroundColor: theme.surface, borderColor: theme.border },
              ]}
            >
              <Text tone="muted" size={13} weight="semibold">
                {loading
                  ? t("sharedChats")
                  : t("sharedChatsCount", { count: shared.length })}
              </Text>
              {loading ? (
                <ActivityIndicator color={theme.muted} />
              ) : shared.length === 0 ? (
                <Text tone="muted" size={14}>
                  {t("sharedChatsEmpty")}
                </Text>
              ) : (
                shared.map((chat) => {
                  const title = chatTitle(chat, t("directChat"));
                  return (
                    <Pressable
                      key={chat.id}
                      accessibilityRole="button"
                      accessibilityLabel={title}
                      onPress={() => router.push(`/chat/${chat.id}`)}
                      style={({ pressed }) => [
                        styles.chat,
                        pressed && { backgroundColor: theme.surfaceSelected },
                      ]}
                    >
                      <ChatAvatar
                        name={title}
                        seed={chat.avatar_seed || chat.id}
                        size={30}
                        shape="square"
                        {...chatAvatarSource(chat)}
                      />
                      <Text size={15} numberOfLines={1} style={styles.grow}>
                        {title}
                      </Text>
                    </Pressable>
                  );
                })
              )}
            </View>
          ) : null}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  loader: { marginTop: spacing[10] },
  content: { padding: spacing[4], gap: spacing[3] },
  card: {
    alignItems: "center",
    gap: spacing[2],
    padding: spacing[5],
    borderRadius: radius.xl,
    borderWidth: 1,
  },
  nameLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: spacing[2],
    flexWrap: "wrap",
    justifyContent: "center",
  },
  center: { textAlign: "center" },
  status: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radius.lg,
  },
  action: { alignSelf: "stretch", marginTop: spacing[2], gap: spacing[2] },
  section: {
    gap: spacing[2],
    padding: spacing[4],
    borderRadius: radius.xl,
    borderWidth: 1,
  },
  chat: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 44,
    borderRadius: radius.md,
  },
  grow: { flex: 1 },
});
