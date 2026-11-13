import { useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import {
  chatAvatarSource,
  chatNameMaxBytes,
  chatRights,
  newChatProblem,
} from "@comamessenger/core";
import { spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { messageOf } from "@/lib/errors";
import { useMessenger } from "@/messenger/MessengerProvider";
import { useSignedIn } from "@/session/SessionProvider";
import { ChatAvatar } from "@/chats/ChatAvatar";
import { chatTitle } from "@/chats/ChatRow";
import { ActionSheet } from "@/ui/ActionSheet";
import { Button } from "@/ui/Button";
import { Notice } from "@/ui/Notice";
import { ScreenHeader } from "@/ui/ScreenHeader";
import { SettingsGroup, SwitchRow } from "@/ui/Settings";
import { Text } from "@/ui/Text";
import { TextField } from "@/ui/TextField";
import { ChatAvatarTooLarge, pickAndUploadChatAvatar } from "./chatAvatar";
import { useChatMembers, viewerOf } from "./queries";

/** Name, description, openness and picture of a group or a channel. */
export function EditChatScreen({ chatID }: { chatID: string }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { api, user } = useSignedIn();
  const { store, reload } = useMessenger();
  const chat = useStore(store, (state) => state.chats[chatID]);
  const { members } = useChatMembers(chatID);
  const viewer = useMemo(() => viewerOf(user), [user]);
  const [name, setName] = useState(chat?.name ?? chat?.display_name ?? "");
  const [topic, setTopic] = useState(chat?.topic ?? "");
  const [open, setOpen] = useState(chat?.visibility === "public");
  const [pending, setPending] = useState(false);
  const [photoMenu, setPhotoMenu] = useState(false);
  const [photoPending, setPhotoPending] = useState(false);
  const [error, setError] = useState("");

  if (!chat || !chatRights(chat, viewer, members).edit)
    return (
      <SafeAreaView
        edges={["bottom"]}
        style={[styles.screen, { backgroundColor: theme.canvas }]}
      >
        <ScreenHeader title={t("editChat")} />
        <View style={styles.form}>
          <Notice tone="neutral" title={t("errorForbidden")} />
        </View>
      </SafeAreaView>
    );

  const channel = chat.kind === "channel";
  const problem = newChatProblem({ name, topic });
  const title = chatTitle(chat, t("directChat"));

  async function save() {
    if (problem || pending) return;
    setPending(true);
    setError("");
    try {
      await api.updateChat(chat!.id, {
        name: name.trim(),
        topic: topic.trim(),
        visibility: open ? "public" : "private",
      });
      await reload();
      router.back();
    } catch (cause) {
      setError(messageOf(cause));
      setPending(false);
    }
  }

  async function changePhoto(action: "change" | "remove") {
    setPhotoMenu(false);
    setPhotoPending(true);
    try {
      if (action === "remove") await api.deleteChatAvatar(chat!.id);
      else {
        // Let the sheet finish closing before the system picker appears.
        await new Promise((resolve) => setTimeout(resolve, 400));
        if (!(await pickAndUploadChatAvatar(api, chat!.id))) return;
      }
      await reload();
    } catch (cause) {
      Alert.alert(
        cause instanceof ChatAvatarTooLarge
          ? t("chatPhotoTooLarge")
          : t("actionFailed"),
      );
    } finally {
      setPhotoPending(false);
    }
  }

  return (
    <SafeAreaView
      testID="edit-chat"
      edges={["bottom"]}
      style={[styles.screen, { backgroundColor: theme.canvas }]}
    >
      <ScreenHeader backTestID="edit-chat-back" title={t("editChat")} />
      <KeyboardAvoidingView behavior="padding" style={styles.grow}>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.form}
        >
          <Pressable
            testID="edit-chat-photo"
            accessibilityRole="button"
            accessibilityLabel={t("chatPhoto")}
            accessibilityState={{ busy: photoPending }}
            disabled={photoPending}
            onPress={() => setPhotoMenu(true)}
            style={styles.photo}
          >
            <ChatAvatar
              name={title}
              seed={chat.avatar_seed || chat.id}
              size={80}
              shape="square"
              {...chatAvatarSource(chat)}
            />
            <Text tone="primary" weight="medium" size={15}>
              {photoPending ? t("uploading") : t("chatPhoto")}
            </Text>
          </Pressable>
          <TextField
            testID="edit-chat-name"
            label={t("chatName")}
            value={name}
            onChangeText={setName}
            maxLength={chatNameMaxBytes}
            error={
              problem === "nameRequired"
                ? t("chatNameRequired")
                : problem === "nameTooLong"
                  ? t("chatNameTooLong")
                  : undefined
            }
          />
          <TextField
            testID="edit-chat-topic"
            label={t("chatTopic")}
            hint={t("optional")}
            value={topic}
            onChangeText={setTopic}
            multiline
            error={
              problem === "topicTooLong" ? t("chatTopicTooLong") : undefined
            }
          />
          <SettingsGroup
            hint={
              channel
                ? open
                  ? t("openChannelHint")
                  : t("privateChannelHint")
                : open
                  ? t("openGroupHint")
                  : t("privateGroupHint")
            }
          >
            <SwitchRow
              label={channel ? t("openChannel") : t("openGroup")}
              value={open}
              onChange={setOpen}
            />
          </SettingsGroup>
          {error ? <Notice title={error} /> : null}
          <Button
            testID="edit-chat-save"
            label={t("save")}
            pending={pending}
            disabled={Boolean(problem)}
            onPress={() => void save()}
          />
        </ScrollView>
      </KeyboardAvoidingView>
      <ActionSheet<"change" | "remove">
        visible={photoMenu}
        options={[
          { value: "change", label: t("changePhoto") },
          ...(chat.avatar_version > 0
            ? [
                {
                  value: "remove" as const,
                  label: t("removePhoto"),
                  danger: true,
                },
              ]
            : []),
        ]}
        onSelect={(action) => void changePhoto(action)}
        onClose={() => setPhotoMenu(false)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  grow: { flex: 1 },
  form: { padding: spacing[4], gap: spacing[4] },
  photo: { alignItems: "center", gap: spacing[2], minHeight: 44 },
});
