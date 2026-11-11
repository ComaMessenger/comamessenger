import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { PinOff } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import {
  chatRights,
  formatListTime,
  messagePlainText,
} from "@comamessenger/core";
import { spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { messageOf } from "@/lib/errors";
import { useMessenger } from "@/messenger/MessengerProvider";
import { useSignedIn } from "@/session/SessionProvider";
import { ChatAvatar } from "@/chats/ChatAvatar";
import { chatTitle } from "@/chats/ChatRow";
import { IconButton } from "@/ui/IconButton";
import { Notice } from "@/ui/Notice";
import { ScreenHeader } from "@/ui/ScreenHeader";
import { Text } from "@/ui/Text";
import {
  chatKeys,
  useChatMembers,
  usePinnedMessages,
  viewerOf,
} from "./queries";

/** Opens the chat at a message; the open chat screen is reused when it is in the stack. */
export function openMessage(chatID: string, messageID: string) {
  router.dismissTo(`/chat/${chatID}?message=${messageID}`);
}

/** Pinned messages of one chat; owners and admins can unpin them here. */
export function PinnedScreen({ chatID }: { chatID: string }) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const { api, user } = useSignedIn();
  const { store } = useMessenger();
  const queryClient = useQueryClient();
  const chat = useStore(store, (state) => state.chats[chatID]);
  const { members } = useChatMembers(chatID);
  const pinned = usePinnedMessages(chatID);
  const [unpinning, setUnpinning] = useState<string | null>(null);
  const viewer = useMemo(() => viewerOf(user), [user]);
  const canPin = chat ? chatRights(chat, viewer, members).pin : false;
  const authorOf = (actorID: string) =>
    members.find((member) => member.actor_id === actorID);

  async function unpin(messageID: string) {
    setUnpinning(messageID);
    try {
      await api.unpin(messageID);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: chatKeys.pins(chatID) }),
        queryClient.invalidateQueries({
          queryKey: chatKeys.pinnedMessages(chatID),
        }),
      ]);
    } catch (cause) {
      Alert.alert(t("actionFailed"), messageOf(cause));
    } finally {
      setUnpinning(null);
    }
  }

  return (
    <SafeAreaView
      testID="pinned-messages"
      edges={["bottom"]}
      style={[styles.screen, { backgroundColor: theme.surface }]}
    >
      <ScreenHeader
        backTestID="pinned-back"
        title={t("pinnedMessages")}
        subtitle={chat ? chatTitle(chat, t("directChat")) : undefined}
      />
      <FlatList
        data={pinned.entries}
        keyExtractor={(entry) => entry.pin.message_id}
        renderItem={({ item, index }) => {
          const author = item.message
            ? authorOf(item.message.actor_id)
            : undefined;
          const name =
            author?.display_name ??
            (item.message?.actor_id === user.id
              ? t("previewYou")
              : t("participant"));
          const text = !item.message
            ? t("pinnedUnavailable")
            : item.message.deleted_at
              ? t("previewDeleted")
              : messagePlainText(item.message.body).trim() ||
                t("previewAttachment");
          const time = formatListTime(
            item.message?.created_at ?? item.pin.pinned_at,
            i18n.language,
            t("yesterday"),
          );
          return (
            <View style={[styles.row, { borderBottomColor: theme.border }]}>
              <Pressable
                testID={`pinned-row-${index}`}
                accessibilityRole="button"
                accessibilityLabel={`${name}, ${time}. ${text}`}
                accessibilityHint={t("openInChatHint")}
                onPress={() => openMessage(chatID, item.pin.message_id)}
                style={({ pressed }) => [
                  styles.main,
                  pressed && { opacity: 0.6 },
                ]}
              >
                <ChatAvatar
                  name={name}
                  seed={item.message?.actor_id ?? item.pin.message_id}
                  actorID={item.message?.actor_id}
                  avatarVersion={author?.avatar_version}
                  agent={author?.type === "agent"}
                  size={36}
                  shape="circle"
                />
                <View style={styles.body}>
                  <View style={styles.head}>
                    <Text
                      weight="semibold"
                      size={14.5}
                      numberOfLines={1}
                      style={styles.grow}
                    >
                      {name}
                    </Text>
                    <Text tone="muted" size={12}>
                      {time}
                    </Text>
                  </View>
                  <Text size={14.5} numberOfLines={3}>
                    {text}
                  </Text>
                </View>
              </Pressable>
              {canPin ? (
                unpinning === item.pin.message_id ? (
                  <ActivityIndicator color={theme.muted} />
                ) : (
                  <IconButton
                    testID={`pinned-unpin-${index}`}
                    label={t("unpinMessage")}
                    onPress={() => void unpin(item.pin.message_id)}
                    icon={(color) => <PinOff size={20} color={color} />}
                  />
                )
              ) : null}
            </View>
          );
        }}
        ListEmptyComponent={
          pinned.loading ? (
            <ActivityIndicator style={styles.loader} color={theme.muted} />
          ) : pinned.failed ? (
            <View style={styles.state}>
              <Notice
                title={t("pinnedLoadFailed")}
                actionLabel={t("retry")}
                onAction={pinned.refetch}
              />
            </View>
          ) : (
            <View style={styles.state}>
              <Text weight="semibold" size={16} style={styles.center}>
                {t("pinnedEmpty")}
              </Text>
              <Text tone="muted" size={14} style={styles.center}>
                {canPin ? t("pinnedEmptyHintAdmin") : t("pinnedEmptyHint")}
              </Text>
            </View>
          )
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[2],
    paddingRight: spacing[2],
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  main: {
    flex: 1,
    flexDirection: "row",
    gap: 10,
    paddingVertical: 11,
    paddingLeft: 14,
  },
  body: { flex: 1, minWidth: 0, gap: 2 },
  head: { flexDirection: "row", alignItems: "baseline", gap: 6 },
  grow: { flex: 1 },
  loader: { marginTop: spacing[10] },
  state: { padding: spacing[5], gap: spacing[2] },
  center: { textAlign: "center" },
});
