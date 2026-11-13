import { useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { ChatMember, ClientMessage } from "@comamessenger/core";
import { spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { useSignedIn } from "@/session/SessionProvider";
import { Avatar } from "@/ui/Avatar";
import { PageSheet } from "@/ui/PageSheet";
import { Text } from "@/ui/Text";
import { reactionsKey } from "./reactions";
import { formatTime } from "./MessageRow";

type Tab = "receipts" | "reactions";
type Person = { actorID: string; trailing: string };

/** «Просмотры и реакции»: who read the message and who reacted, as on the web. */
export function MessageDetailsSheet({
  message,
  members,
  onClose,
}: {
  message: ClientMessage | null;
  members: ChatMember[];
  onClose(): void;
}) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const { api, user } = useSignedIn();
  const [tab, setTab] = useState<Tab>("receipts");
  const id = message?.id ?? "";
  const receipts = useQuery({
    queryKey: ["message-receipts", id],
    queryFn: () => api.receipts(id),
    enabled: Boolean(message),
  });
  const reactions = useQuery({
    queryKey: reactionsKey(id),
    queryFn: () => api.reactions(id),
    enabled: Boolean(message),
  });
  const memberOf = (actorID: string) =>
    members.find((member) => member.actor_id === actorID);
  const nameOf = (actorID: string) =>
    actorID === user.id
      ? user.display_name
      : (memberOf(actorID)?.display_name ?? t("participant"));

  const readers: Person[] = (receipts.data ?? [])
    .filter((receipt) => receipt.actor_id !== message?.actor_id)
    .map((receipt) => ({
      actorID: receipt.actor_id,
      trailing: formatTime(receipt.read_at, i18n.language),
    }));
  const reacted = new Map<string, string[]>();
  for (const reaction of reactions.data ?? [])
    reacted.set(reaction.actor_id, [
      ...(reacted.get(reaction.actor_id) ?? []),
      reaction.emoji,
    ]);
  const reactors: Person[] = [...reacted].map(([actorID, emojis]) => ({
    actorID,
    trailing: emojis.join(" "),
  }));
  const others = members.filter(
    (member) =>
      member.actor_id !== message?.actor_id && member.actor_id !== user.id,
  ).length;
  const unread = Math.max(0, others - readers.length);
  const active = tab === "receipts" ? receipts : reactions;
  const people = tab === "receipts" ? readers : reactors;

  return (
    <PageSheet
      testID="message-details"
      visible={message !== null}
      title={t("viewsAndReactions")}
      onClose={() => {
        setTab("receipts");
        onClose();
      }}
    >
      <View
        accessibilityRole="tablist"
        style={[styles.tabs, { borderBottomColor: theme.border }]}
      >
        {(
          [
            ["receipts", t("viewsTab", { count: readers.length })],
            [
              "reactions",
              t("reactionsTab", { count: reactions.data?.length ?? 0 }),
            ],
          ] as const
        ).map(([value, label]) => {
          const selected = tab === value;
          return (
            <Pressable
              key={value}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              onPress={() => setTab(value)}
              style={[
                styles.tab,
                { borderBottomColor: selected ? theme.primary : "transparent" },
              ]}
            >
              <Text
                weight="semibold"
                size={14}
                tone={selected ? "primary" : "muted"}
              >
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {active.isPending ? (
        <ActivityIndicator style={styles.loader} color={theme.muted} />
      ) : (
        <FlatList
          data={people}
          keyExtractor={(person) => person.actorID}
          ListEmptyComponent={
            <Text tone="muted" size={15} style={styles.empty}>
              {tab === "receipts" ? t("nobodyRead") : t("noReactions")}
            </Text>
          }
          ListFooterComponent={
            tab === "receipts" && unread > 0 && readers.length > 0 ? (
              <Text tone="muted" size={13} style={styles.more}>
                {t("detailsUnread", { count: unread })}
              </Text>
            ) : null
          }
          renderItem={({ item }) => {
            const member = memberOf(item.actorID);
            return (
              <View
                accessible
                accessibilityLabel={`${nameOf(item.actorID)}, ${item.trailing}`}
                style={styles.row}
              >
                <Avatar
                  name={nameOf(item.actorID)}
                  seed={item.actorID}
                  size={36}
                  agent={member?.type === "agent"}
                  actorID={item.actorID}
                  avatarVersion={member?.avatar_version}
                />
                <Text
                  weight="semibold"
                  size={15}
                  numberOfLines={1}
                  style={styles.name}
                >
                  {nameOf(item.actorID)}
                </Text>
                <Text tone="muted" size={14} style={styles.trailing}>
                  {item.trailing}
                </Text>
              </View>
            );
          }}
        />
      )}
    </PageSheet>
  );
}

const styles = StyleSheet.create({
  tabs: {
    flexDirection: "row",
    borderBottomWidth: 1,
    paddingHorizontal: spacing[2],
  },
  tab: {
    flex: 1,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderBottomWidth: 2,
  },
  loader: { marginTop: spacing[8] },
  empty: { textAlign: "center", padding: spacing[6] },
  more: { textAlign: "center", padding: spacing[4] },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
    minHeight: 52,
  },
  name: { flex: 1 },
  trailing: { fontVariant: ["tabular-nums"] },
});
