import { useMemo } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import { useQueries } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import {
  chatAvatarSource,
  expandDepartment,
  type Chat,
  type ChatMember,
  type OrgStructure,
  type RequestDraftAudience,
} from "@comamessenger/core";
import { spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { useMessenger } from "@/messenger/MessengerProvider";
import { withCache } from "@/messenger/cache";
import { useSignedIn } from "@/session/SessionProvider";
import { ChatAvatar } from "@/chats/ChatAvatar";
import { chatTitle } from "@/chats/ChatRow";
import { PageSheet } from "@/ui/PageSheet";
import { Text } from "@/ui/Text";

const chatLimit = 60;

export type RequestChatChoice =
  | { kind: "chat"; chat: Chat; members: ChatMember[] }
  /** No direct chat yet: open one first. */
  | { kind: "direct"; actorID: string };

/**
 * «Запрос» from a department or a person card: where to ask. For a
 * department — its chat first, then the reader's chats with people of the
 * department, each with how many; for a person — the direct chat first,
 * then shared groups.
 */
export function RequestChatPicker({
  visible,
  audience,
  structure,
  departmentChatID,
  onClose,
  onPick,
}: {
  visible: boolean;
  /** A department, or one person (`people` with one id). */
  audience: RequestDraftAudience;
  structure: OrgStructure;
  departmentChatID?: string | null;
  onClose(): void;
  onPick(choice: RequestChatChoice): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { api, user } = useSignedIn();
  const { store } = useMessenger();
  const chatMap = useStore(store, (state) => state.chats);
  const person = audience.kind === "people" ? audience.actorIDs[0] : null;
  const candidates = useMemo(
    () =>
      Object.values(chatMap)
        .filter(
          (chat) =>
            !chat.archived_at &&
            (chat.kind === "group" ||
              (person !== null &&
                chat.kind === "direct" &&
                chat.direct_peer?.actor_id === person)),
        )
        .slice(0, chatLimit),
    [chatMap, person],
  );
  const results = useQueries({
    queries: candidates.map((chat) => ({
      queryKey: ["members", chat.id],
      queryFn: () =>
        withCache(`members:${chat.id}`, () => api.members(chat.id)),
      staleTime: 5 * 60_000,
      enabled: visible,
    })),
  });
  const loading = results.some((result) => result.isLoading);
  // useQueries gives a new array every render; its answers are what matter.
  const answered = results.map((result) => result.dataUpdatedAt).join(",");

  const rows = useMemo(() => {
    const list: { chat: Chat; members: ChatMember[]; count: number }[] = [];
    candidates.forEach((chat, index) => {
      const members = results[index]?.data;
      if (!members) return;
      const ids = members
        .filter((member) => member.type === "user")
        .map((member) => member.actor_id);
      const count =
        audience.kind === "department"
          ? expandDepartment(structure, audience.departmentID, {
              chatMemberIDs: ids,
              excludeActorID: user.id,
            }).inChat.length
          : person && ids.includes(person)
            ? 1
            : 0;
      if (count > 0) list.push({ chat, members, count });
    });
    const first = (chat: Chat) =>
      chat.id === departmentChatID || chat.kind === "direct" ? 0 : 1;
    return list.sort(
      (left, right) =>
        first(left.chat) - first(right.chat) || right.count - left.count,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    answered,
    audience,
    candidates,
    departmentChatID,
    person,
    structure,
    user.id,
  ]);
  const needsDirect =
    person !== null && !rows.some((row) => row.chat.kind === "direct");

  return (
    <PageSheet
      visible={visible}
      title={t("orgRequestChatTitle")}
      onClose={onClose}
      testID="request-chat-picker"
    >
      <FlatList
        data={rows}
        keyExtractor={(row) => row.chat.id}
        ListHeaderComponent={
          <View>
            <Text tone="muted" size={13.5} style={styles.hint}>
              {t("orgRequestChatHint")}
            </Text>
            {needsDirect && person ? (
              <Pressable
                testID="request-chat-direct"
                accessibilityRole="button"
                onPress={() => onPick({ kind: "direct", actorID: person })}
                style={({ pressed }) => [
                  styles.row,
                  pressed && { backgroundColor: theme.surfaceSelected },
                ]}
              >
                <ChatAvatar
                  name={t("orgRequestDirect")}
                  seed={person}
                  actorID={person}
                  size={40}
                  shape="circle"
                />
                <Text size={15.5} style={styles.grow}>
                  {t("orgRequestDirect")}
                </Text>
              </Pressable>
            ) : null}
          </View>
        }
        ListFooterComponent={
          loading ? (
            <ActivityIndicator style={styles.loader} color={theme.muted} />
          ) : null
        }
        renderItem={({ item, index }) => {
          const title = chatTitle(item.chat, t("directChat"));
          return (
            <Pressable
              testID={`request-chat-${index}`}
              accessibilityRole="button"
              onPress={() =>
                onPick({ kind: "chat", chat: item.chat, members: item.members })
              }
              style={({ pressed }) => [
                styles.row,
                pressed && { backgroundColor: theme.surfaceSelected },
              ]}
            >
              <ChatAvatar
                name={title}
                seed={item.chat.avatar_seed || item.chat.id}
                size={40}
                shape={item.chat.kind === "direct" ? "circle" : "square"}
                {...chatAvatarSource(item.chat)}
              />
              <View style={styles.grow}>
                <Text size={15.5} numberOfLines={1}>
                  {item.chat.kind === "direct" ? t("orgRequestDirect") : title}
                </Text>
                {audience.kind === "department" ? (
                  <Text tone="muted" size={13}>
                    {t("orgRequestChatPeople", { count: item.count })}
                  </Text>
                ) : null}
              </View>
            </Pressable>
          );
        }}
      />
    </PageSheet>
  );
}

const styles = StyleSheet.create({
  hint: { padding: spacing[4] },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: spacing[4],
    paddingVertical: 8,
    minHeight: 56,
  },
  grow: { flex: 1, minWidth: 0 },
  loader: { marginVertical: spacing[4] },
});
