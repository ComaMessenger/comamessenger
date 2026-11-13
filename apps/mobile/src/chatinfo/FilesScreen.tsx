import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Download, FileText, Image as ImageIcon } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { formatListTime } from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { useMessenger } from "@/messenger/MessengerProvider";
import { useSignedIn } from "@/session/SessionProvider";
import { chatTitle } from "@/chats/ChatRow";
import { openAttachment } from "@/files/open";
import { IconButton } from "@/ui/IconButton";
import { Notice } from "@/ui/Notice";
import { ScreenHeader } from "@/ui/ScreenHeader";
import { Text } from "@/ui/Text";
import { openMessage } from "./PinnedScreen";
import { useChatFiles, useChatMembers } from "./queries";

/** Files sent to a chat: tap opens the message, the button opens the file. */
export function FilesScreen({ chatID }: { chatID: string }) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const { api } = useSignedIn();
  const { store } = useMessenger();
  const chat = useStore(store, (state) => state.chats[chatID]);
  const { members } = useChatMembers(chatID);
  const files = useChatFiles(chatID);
  const [opening, setOpening] = useState<string | null>(null);
  const results = (files.data?.results ?? []).filter((item) => item.file_id);

  async function open(fileID: string) {
    setOpening(fileID);
    try {
      await openAttachment(api, await api.file(fileID));
    } catch {
      Alert.alert(t("actionFailed"));
    } finally {
      setOpening(null);
    }
  }

  return (
    <SafeAreaView
      testID="chat-files"
      edges={["bottom"]}
      style={[styles.screen, { backgroundColor: theme.surface }]}
    >
      <ScreenHeader
        backTestID="files-back"
        title={t("chatFiles")}
        subtitle={chat ? chatTitle(chat, t("directChat")) : undefined}
      />
      <FlatList
        data={results}
        keyExtractor={(item) => `${item.message_id}:${item.file_id}`}
        renderItem={({ item, index }) => {
          const image = item.file_mime?.startsWith("image/");
          const Icon = image ? ImageIcon : FileText;
          const meta = [
            item.file_mime?.split("/").pop()?.toUpperCase(),
            members.find((member) => member.actor_id === item.actor_id)
              ?.display_name,
            formatListTime(item.created_at, i18n.language, t("yesterday")),
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <View style={[styles.row, { borderBottomColor: theme.border }]}>
              <Pressable
                testID={`file-row-${index}`}
                accessibilityRole="button"
                accessibilityLabel={`${item.file_name ?? ""}, ${meta}`}
                accessibilityHint={t("openInChatHint")}
                onPress={() => openMessage(chatID, item.message_id)}
                style={({ pressed }) => [
                  styles.main,
                  pressed && styles.pressed,
                ]}
              >
                <View
                  style={[styles.icon, { backgroundColor: theme.primarySoft }]}
                >
                  <Icon size={20} color={theme.primary} />
                </View>
                <View style={styles.body}>
                  <Text weight="medium" size={15} numberOfLines={1}>
                    {item.file_name}
                  </Text>
                  <Text tone="muted" size={12.5} numberOfLines={1}>
                    {meta}
                  </Text>
                </View>
              </Pressable>
              {opening === item.file_id ? (
                <ActivityIndicator color={theme.muted} style={styles.spin} />
              ) : (
                <IconButton
                  label={t("openFile")}
                  onPress={() => void open(item.file_id!)}
                  icon={(color) => <Download size={20} color={color} />}
                />
              )}
            </View>
          );
        }}
        ListEmptyComponent={
          files.isLoading ? (
            <ActivityIndicator style={styles.loader} color={theme.muted} />
          ) : files.isError ? (
            <View style={styles.state}>
              <Notice
                title={t("filesLoadFailed")}
                actionLabel={t("retry")}
                onAction={() => void files.refetch()}
              />
            </View>
          ) : (
            <View style={styles.state}>
              <Text weight="semibold" size={16} style={styles.center}>
                {t("filesEmpty")}
              </Text>
              <Text tone="muted" size={14} style={styles.center}>
                {t("filesEmptyHint")}
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
    paddingRight: spacing[2],
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  main: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 10,
    paddingLeft: 14,
  },
  pressed: { opacity: 0.6 },
  icon: {
    width: 40,
    height: 40,
    borderRadius: radius.tile,
    alignItems: "center",
    justifyContent: "center",
  },
  body: { flex: 1, minWidth: 0 },
  spin: { width: 40 },
  loader: { marginTop: spacing[10] },
  state: { padding: spacing[5], gap: spacing[2] },
  center: { textAlign: "center" },
});
