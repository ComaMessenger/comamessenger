import { memo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import {
  formatListTime,
  formatPollDue,
  type WaitingPollItem,
} from "@comamessenger/core";
import { useTheme } from "@/lib/theme";
import { useMessenger } from "@/messenger/MessengerProvider";
import { ChatAvatar } from "@/chats/ChatAvatar";
import { chatTitle } from "@/chats/ChatRow";
import { Text } from "@/ui/Text";
import { useNow } from "@/scheduled/clock";
import { calendarLocale } from "@/requests/locale";
import { PollMessage } from "./PollMessage";

/**
 * A poll with a due date in «Важные → Ждут вас» (decision 14): who asks,
 * the chat and «до …», then the options to vote right here. After the vote
 * the poll leaves the list; «Открыть в чате» shows the results.
 */
export const WaitingPollRow = memo(function WaitingPollRow({
  item,
  testID,
  onNotice,
}: {
  item: WaitingPollItem;
  testID?: string;
  onNotice(text: string): void;
}) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const { store } = useMessenger();
  const now = useNow(60_000);
  const chatID = item.message.chat_id;
  const localChat = useStore(store, (state) => state.chats[chatID]);
  const chatName = localChat
    ? chatTitle(localChat, t("directChat"))
    : item.chat.display_name || t("directChat");
  const poll = item.message.poll;
  const due = poll.due_at
    ? t("pollDueBy", {
        when: formatPollDue(
          new Date(poll.due_at),
          now,
          calendarLocale(i18n.language),
        ),
      })
    : null;
  const open = () => router.push(`/chat/${chatID}?message=${item.message.id}`);
  return (
    <View
      testID={testID}
      style={[
        styles.card,
        { backgroundColor: theme.surface, borderBottomColor: theme.border },
      ]}
    >
      <ChatAvatar
        name={item.author.display_name}
        seed={item.author.actor_id}
        size={36}
        shape="circle"
        actorID={item.author.actor_id}
        avatarVersion={item.author.avatar_version}
      />
      <View style={styles.body}>
        <View style={styles.line}>
          <Text weight="semibold" size={14.5} style={styles.grow}>
            {t("importantPollFrom", { name: item.author.display_name })}
          </Text>
          <Text tone="muted" size={12}>
            {formatListTime(
              item.message.created_at,
              i18n.language,
              t("yesterday"),
            )}
          </Text>
        </View>
        <Text weight="medium" size={12.5} tone="primary" style={styles.chat}>
          {[chatName, due].filter(Boolean).join(" · ")}
        </Text>
        <PollMessage
          message={item.message}
          fallback={item.viewer}
          compact
          onNotice={onNotice}
        />
        <Pressable
          testID={testID ? `${testID}-open` : undefined}
          accessibilityRole="link"
          hitSlop={8}
          onPress={open}
          style={styles.open}
        >
          <Text tone="primary" weight="semibold" size={13}>
            {t("importantOpenPoll")}
          </Text>
        </Pressable>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderBottomWidth: 1,
  },
  body: { flex: 1, minWidth: 0 },
  line: { flexDirection: "row", alignItems: "baseline", gap: 6 },
  grow: { flex: 1 },
  chat: { marginBottom: 3 },
  open: { marginTop: 8, alignSelf: "flex-start", minHeight: 24 },
});
