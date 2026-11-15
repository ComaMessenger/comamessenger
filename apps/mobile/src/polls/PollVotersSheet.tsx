import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  pollKeys,
  pollVoterTabs,
  type ChatMember,
  type MessagePoll,
  type PollVoterTab,
  type PollViewer,
} from "@comamessenger/core";
import { useTheme } from "@/lib/theme";
import { useSignedIn } from "@/session/SessionProvider";
import { Avatar } from "@/ui/Avatar";
import { BottomSheet } from "@/ui/BottomSheet";
import { Text } from "@/ui/Text";
import { calendarLocale } from "@/requests/locale";
import { SectionLabel, SmallButton } from "@/requests/parts";
import { useWorkspacePeople } from "@/status/useAway";
import type { PollActions } from "./usePoll";

const pageSize = 50;

/**
 * «Кто голосовал» (prototype «Опросы», phone C): the voters of each option
 * one under another, then «Не ответили · k» with «Напомнить» for the author
 * and chat admins. Nobody sees names in an anonymous poll, so the sheet is
 * only offered for ordinary ones. A voter who left the chat stays in the
 * count with «не в чате».
 */
export function PollVotersSheet({
  visible,
  messageID,
  poll,
  viewer,
  members,
  actions,
  onClose,
}: {
  visible: boolean;
  messageID: string;
  poll: MessagePoll;
  viewer: PollViewer | null;
  members: ChatMember[];
  actions: PollActions;
  onClose(): void;
}) {
  const { t, i18n } = useTranslation();
  const counts =
    poll.status === "open" ? viewer?.counts : (poll.final_counts ?? null);
  const tabs = pollVoterTabs(
    poll,
    viewer ? { ...viewer, counts: counts ?? viewer.counts } : null,
    calendarLocale(i18n.language),
  );
  return (
    <BottomSheet
      visible={visible}
      title={t("pollVotersTitle")}
      action={{ label: t("pollVotersDone"), onPress: onClose }}
      onClose={onClose}
      testID="poll-voters"
    >
      <Text tone="muted" size={13} style={styles.question}>
        {poll.question}
      </Text>
      {visible
        ? tabs.map((tab) => (
            <VoterSection
              key={tab.filter}
              tab={tab}
              messageID={messageID}
              version={poll.version}
              members={members}
              canRemind={
                tab.filter === "waiting" &&
                poll.status === "open" &&
                Boolean(viewer?.can_remind)
              }
              actions={actions}
            />
          ))
        : null}
    </BottomSheet>
  );
}

function VoterSection({
  tab,
  messageID,
  version,
  members,
  canRemind,
  actions,
}: {
  tab: PollVoterTab;
  messageID: string;
  version: number;
  members: ChatMember[];
  canRemind: boolean;
  actions: PollActions;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { api, user } = useSignedIn();
  const waiting = tab.filter === "waiting";
  const query = useInfiniteQuery({
    queryKey: [...pollKeys.voters(user.id, messageID, tab.filter), version],
    queryFn: ({ pageParam }) =>
      api.pollVoters(messageID, {
        filter: tab.filter,
        limit: pageSize,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: "",
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    enabled: tab.count > 0,
    staleTime: 15_000,
  });
  const items = (query.data?.pages ?? []).flatMap((page) => page.items);
  // People who left the chat are not among its members.
  const missing = items.some(
    (item) => !members.some((member) => member.actor_id === item.actor_id),
  );
  const directory = useWorkspacePeople(missing);
  const person = (actorID: string) =>
    members.find((member) => member.actor_id === actorID) ??
    directory.byID.get(actorID);

  return (
    <View testID={`poll-voters-${tab.filter.replace(":", "-")}`}>
      <View style={styles.head}>
        <View style={styles.grow}>
          <SectionLabel>
            {waiting ? tab.label : `${tab.label} · ${tab.count}`}
          </SectionLabel>
        </View>
        {canRemind && tab.count > 0 ? (
          <SmallButton
            testID="poll-voters-remind"
            label={t("pollVotersRemind")}
            disabled={actions.busy !== null}
            onPress={() => void actions.remind()}
          />
        ) : null}
      </View>
      {tab.count === 0 ? (
        <Text tone="muted" size={14} style={styles.nobody}>
          {t("pollVotersNobody")}
        </Text>
      ) : query.isLoading ? (
        <ActivityIndicator style={styles.loader} color={theme.muted} />
      ) : query.isError ? (
        <Text tone="danger" size={14} style={styles.nobody}>
          {t("pollVotersLoadFailed")}
        </Text>
      ) : (
        items.map((item) => {
          const found = person(item.actor_id);
          const name =
            found?.display_name ??
            (item.actor_id === user.id ? t("previewYou") : t("participant"));
          const caption = [
            found?.title,
            item.in_chat ? null : t("pollVotersNotInChat"),
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <View
              key={item.actor_id}
              style={styles.row}
              accessible
              accessibilityLabel={[name, caption].filter(Boolean).join(", ")}
            >
              <Avatar
                name={name}
                seed={item.actor_id}
                size={36}
                actorID={item.actor_id}
                avatarVersion={found?.avatar_version}
              />
              <View style={styles.grow}>
                <Text size={15} numberOfLines={1}>
                  {name}
                </Text>
                {caption ? (
                  <Text tone="muted" size={12.5} numberOfLines={1}>
                    {caption}
                  </Text>
                ) : null}
              </View>
            </View>
          );
        })
      )}
      {query.hasNextPage ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => void query.fetchNextPage()}
          style={styles.more}
        >
          {query.isFetchingNextPage ? (
            <ActivityIndicator color={theme.muted} />
          ) : (
            <Text tone="primary" weight="semibold" size={14}>
              {t("pollVotersMore")}
            </Text>
          )}
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  question: { marginBottom: 4 },
  head: { flexDirection: "row", alignItems: "center", gap: 8 },
  grow: { flex: 1, minWidth: 0 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 6,
  },
  nobody: { marginBottom: 4 },
  loader: { marginVertical: 8 },
  more: { minHeight: 40, justifyContent: "center" },
});
