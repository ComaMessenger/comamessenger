import { useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { chatRights, type ActorSummary } from "@comamessenger/core";
import { spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { messageOf } from "@/lib/errors";
import { useMessenger } from "@/messenger/MessengerProvider";
import { useSignedIn } from "@/session/SessionProvider";
import { chatTitle } from "@/chats/ChatRow";
import { PeoplePicker } from "@/people/PeoplePicker";
import { ScreenHeader } from "@/ui/ScreenHeader";
import { Text } from "@/ui/Text";
import { chatKeys, useChatMembers, viewerOf } from "./queries";

/** Adds people and agents to a group or a channel; one request per person, as on the web. */
export function AddMembersScreen({ chatID }: { chatID: string }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { api, user } = useSignedIn();
  const { store } = useMessenger();
  const queryClient = useQueryClient();
  const chat = useStore(store, (state) => state.chats[chatID]);
  const { members } = useChatMembers(chatID);
  const viewer = useMemo(() => viewerOf(user), [user]);
  const [selected, setSelected] = useState<ActorSummary[]>([]);
  const [pending, setPending] = useState(false);
  const exclude = useMemo(
    () => members.map((member) => member.actor_id),
    [members],
  );
  const allowed = chat ? chatRights(chat, viewer, members).addMembers : false;

  async function add() {
    if (!selected.length || pending) return;
    setPending(true);
    const failed: ActorSummary[] = [];
    let lastError: unknown = null;
    for (const actor of selected) {
      try {
        await api.addMember(chatID, actor.actor_id);
      } catch (cause) {
        failed.push(actor);
        lastError = cause;
      }
    }
    await queryClient.invalidateQueries({ queryKey: chatKeys.members(chatID) });
    setPending(false);
    if (failed.length) {
      // Those added leave the list; the rest stay chosen for another try.
      setSelected(failed);
      Alert.alert(
        t("addMembersFailed", {
          names: failed.map((actor) => actor.display_name).join(", "),
        }),
        messageOf(lastError),
      );
      return;
    }
    router.back();
  }

  return (
    <SafeAreaView
      testID="add-members"
      edges={["bottom"]}
      style={[styles.screen, { backgroundColor: theme.surface }]}
    >
      <ScreenHeader
        backTestID="add-members-back"
        title={t("addMembers")}
        subtitle={chat ? chatTitle(chat, t("directChat")) : undefined}
        trailing={
          pending ? (
            <ActivityIndicator color={theme.muted} style={styles.action} />
          ) : (
            <Pressable
              testID="add-members-done"
              accessibilityRole="button"
              accessibilityState={{ disabled: !selected.length || !allowed }}
              disabled={!selected.length || !allowed}
              hitSlop={8}
              onPress={() => void add()}
              style={styles.action}
            >
              <Text
                weight="semibold"
                size={16}
                style={{
                  color:
                    selected.length && allowed ? theme.primary : theme.subtle,
                }}
              >
                {selected.length
                  ? t("addCount", { count: selected.length })
                  : t("add")}
              </Text>
            </Pressable>
          )
        }
      />
      {allowed ? (
        <PeoplePicker
          testID="add-members-picker"
          selected={selected}
          onChange={setSelected}
          exclude={exclude}
        />
      ) : (
        <Text tone="muted" size={15} style={styles.state}>
          {t("errorForbidden")}
        </Text>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  action: {
    minHeight: 44,
    minWidth: 44,
    justifyContent: "center",
    paddingHorizontal: spacing[2],
  },
  state: { padding: spacing[5] },
});
