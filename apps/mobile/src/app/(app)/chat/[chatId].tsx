import { useEffect, useMemo } from "react";
import { FlatList, Pressable, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import { ChevronLeft } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { messagePlainText, type ClientMessage } from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { useMessenger } from "@/messenger/MessengerProvider";
import { useSignedIn } from "@/session/SessionProvider";
import { useTheme } from "@/lib/theme";
import { chatTitle } from "@/chats/ChatRow";
import { Avatar } from "@/ui/Avatar";
import { Text } from "@/ui/Text";

const noMessages: ClientMessage[] = [];

// Read-only preview of the conversation; the full feed and composer are M2.
export default function ChatScreen() {
  const { chatId } = useLocalSearchParams<{ chatId: string }>();
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const { api, user } = useSignedIn();
  const { store, coordinator } = useMessenger();
  const chat = useStore(store, (state) => state.chats[chatId]);
  const messages = useStore(
    store,
    (state) => state.messages[chatId] ?? noMessages,
  );
  const title = chat ? chatTitle(chat, t("directChat")) : "";
  const time = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language, {
        hour: "2-digit",
        minute: "2-digit",
      }),
    [i18n.language],
  );

  useEffect(() => {
    store.getState().setActive(chatId);
    coordinator.subscribe(chatId, null);
    void api
      .messages(chatId, { limit: 50 })
      .then((page) => {
        store.getState().replaceMessages(chatId, page.messages);
        const last = page.messages.at(-1);
        if (last)
          void api.markRead(chatId, last.created_seq).catch(() => undefined);
      })
      .catch(() => undefined);
    return () => {
      store.getState().setActive(null);
      coordinator.subscribe(null, null);
    };
  }, [api, chatId, coordinator, store]);

  const feed = useMemo(
    () =>
      messages
        .filter((message) => !message.thread_root_id)
        .slice()
        .reverse(),
    [messages],
  );

  return (
    <SafeAreaView
      testID="conversation"
      edges={["top", "bottom"]}
      style={styles.screen}
    >
      <View style={[styles.header, { borderBottomColor: theme.border }]}>
        <Pressable
          testID="conversation-back"
          accessibilityRole="button"
          accessibilityLabel={t("back")}
          hitSlop={12}
          onPress={() => router.back()}
        >
          <ChevronLeft size={28} color={theme.primary} />
        </Pressable>
        {chat && (
          <Avatar
            name={title}
            seed={chat.avatar_seed || chat.id}
            size={36}
            glyph={chat.kind === "channel" ? "#" : undefined}
            agent={chat.direct_peer?.type === "agent"}
          />
        )}
        <Text
          accessibilityRole="header"
          weight="semibold"
          size={17}
          numberOfLines={1}
          style={styles.grow}
        >
          {title}
        </Text>
      </View>
      <FlatList
        inverted
        data={feed}
        keyExtractor={(message) => message.client_msg_id || message.id}
        contentContainerStyle={styles.feed}
        renderItem={({ item }) => {
          const own = item.actor_id === user.id;
          return (
            <View
              style={[
                styles.bubble,
                own
                  ? {
                      alignSelf: "flex-end",
                      backgroundColor: theme.primarySoft,
                    }
                  : { alignSelf: "flex-start", backgroundColor: theme.surface },
              ]}
            >
              <Text size={16}>
                {item.deleted_at
                  ? t("previewDeleted")
                  : messagePlainText(item.body)}
              </Text>
              <Text tone="subtle" size={12} style={styles.time}>
                {time.format(new Date(item.created_at))}
              </Text>
            </View>
          );
        }}
        ListEmptyComponent={
          <Text tone="muted" size={15} style={styles.empty}>
            {t("noMessages")}
          </Text>
        }
      />
      <View style={[styles.note, { borderTopColor: theme.border }]}>
        <Text tone="muted" size={14} style={styles.center}>
          {t("conversationPreviewNote")}
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[3],
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  grow: { flex: 1 },
  feed: { padding: spacing[3], gap: spacing[2] },
  bubble: {
    maxWidth: "82%",
    borderRadius: radius.xl,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
  },
  time: { alignSelf: "flex-end", marginTop: 2 },
  empty: {
    textAlign: "center",
    padding: spacing[6],
    transform: [{ scaleY: -1 }],
  },
  note: { padding: spacing[3], borderTopWidth: StyleSheet.hairlineWidth },
  center: { textAlign: "center" },
});
