import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { Check, Search } from "lucide-react-native";
import { useStore } from "zustand";
import { useTranslation } from "react-i18next";
import {
  chatAvatarSource,
  isReadOnly,
  messagePlainText,
  type Chat,
  type ClientMessage,
} from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { useMessenger } from "@/messenger/MessengerProvider";
import { useSignedIn } from "@/session/SessionProvider";
import { chatTitle } from "@/chats/ChatRow";
import { Avatar } from "@/ui/Avatar";
import { PageSheet } from "@/ui/PageSheet";
import { Text, fonts, maxTextScale } from "@/ui/Text";

/**
 * Forwarding, as on the web: pick one or more chats, add an optional
 * comment; each chat gets the forwarded message and then the comment.
 */
export function ForwardSheet({
  message,
  authorName,
  chatName,
  onClose,
  onDone,
}: {
  message: ClientMessage | null;
  authorName: string;
  chatName: string;
  onClose(): void;
  /** Reports the outcome in a line the screen shows briefly. */
  onDone(notice: string): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { api } = useSignedIn();
  const { store } = useMessenger();
  const chatMap = useStore(store, (state) => state.chats);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [comment, setComment] = useState("");
  const [sending, setSending] = useState(false);
  const titleOf = (chat: Chat) => chatTitle(chat, t("directChat"));
  const chats = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return Object.values(chatMap)
      .filter((chat) => chatTitle(chat, "").toLowerCase().includes(needle))
      .sort((left, right) => right.last_activity_seq - left.last_activity_seq);
  }, [chatMap, query]);

  function close() {
    setQuery("");
    setSelected([]);
    setComment("");
    onClose();
  }

  async function submit() {
    if (!message || !selected.length || sending) return;
    setSending(true);
    const results = await Promise.all(
      selected.map(async (chatID) => {
        try {
          await api.forward(message.id, chatID, crypto.randomUUID());
          if (comment.trim())
            await api.createMessage(chatID, {
              client_msg_id: crypto.randomUUID(),
              body: comment.trim(),
              body_format: "markdown",
              mentioned_actor_ids: [],
            });
          return { chatID, ok: true };
        } catch {
          return { chatID, ok: false };
        }
      }),
    );
    setSending(false);
    const nameOf = (chatID: string) => {
      const chat = chatMap[chatID];
      return chat ? titleOf(chat) : "";
    };
    const failed = results
      .filter((item) => !item.ok)
      .map((item) => item.chatID);
    if (!failed.length) {
      onDone(t("forwardSent", { chat: selected.map(nameOf).join(", ") }));
      close();
      return;
    }
    // Chats that failed stay selected for another try.
    setSelected(failed);
    onDone(t("forwardFailed", { chat: failed.map(nameOf).join(", ") }));
  }

  const metaOf = (chat: Chat) =>
    isReadOnly(chat)
      ? t("chatMetaReadOnly")
      : chat.kind === "direct"
        ? t("chatMetaDirect")
        : chat.kind === "group"
          ? t("chatMetaGroup")
          : t("chatMetaChannel");

  return (
    <PageSheet
      testID="forward-sheet"
      visible={message !== null}
      title={t("forwardTitle")}
      onClose={close}
      trailing={
        <Pressable
          testID="forward-send"
          accessibilityRole="button"
          accessibilityState={{ disabled: !selected.length, busy: sending }}
          disabled={!selected.length || sending}
          onPress={() => void submit()}
          style={[
            styles.send,
            {
              backgroundColor: selected.length
                ? theme.primary
                : theme.surfaceSelected,
            },
          ]}
        >
          {sending ? (
            <ActivityIndicator color={theme.onPrimary} />
          ) : (
            <Text
              weight="semibold"
              size={14}
              style={{
                color: selected.length ? theme.onPrimary : theme.muted,
              }}
            >
              {t("forwardSelected", { count: selected.length })}
            </Text>
          )}
        </Pressable>
      }
    >
      {message && (
        <View style={[styles.quote, { borderLeftColor: theme.primary }]}>
          <Text weight="semibold" size={13} tone="primary" numberOfLines={1}>
            {chatName ? `${authorName} · ${chatName}` : authorName}
          </Text>
          <Text tone="muted" size={14} numberOfLines={2}>
            {messagePlainText(message.body)}
          </Text>
        </View>
      )}
      <View style={styles.fields}>
        <TextInput
          value={comment}
          onChangeText={setComment}
          placeholder={t("forwardComment")}
          placeholderTextColor={theme.muted}
          accessibilityLabel={t("forwardComment")}
          maxFontSizeMultiplier={maxTextScale}
          selectionColor={theme.primary}
          style={[
            styles.field,
            {
              color: theme.foreground,
              borderColor: theme.borderStrong,
              backgroundColor: theme.surface,
            },
          ]}
        />
        <View
          style={[styles.search, { backgroundColor: theme.surfaceSelected }]}
        >
          <Search size={18} color={theme.muted} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={t("forwardSearch")}
            placeholderTextColor={theme.muted}
            accessibilityLabel={t("forwardSearch")}
            maxFontSizeMultiplier={maxTextScale}
            selectionColor={theme.primary}
            autoCorrect={false}
            style={[styles.searchInput, { color: theme.foreground }]}
          />
        </View>
      </View>
      <FlatList
        data={chats}
        keyExtractor={(chat) => chat.id}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        ListEmptyComponent={
          <Text tone="muted" size={15} style={styles.empty}>
            {t("noChatsFound")}
          </Text>
        }
        renderItem={({ item: chat }) => {
          const checked = selected.includes(chat.id);
          const disabled = isReadOnly(chat);
          const title = titleOf(chat);
          return (
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked, disabled }}
              accessibilityLabel={`${title}, ${metaOf(chat)}`}
              disabled={disabled}
              onPress={() =>
                setSelected((current) =>
                  current.includes(chat.id)
                    ? current.filter((id) => id !== chat.id)
                    : [...current, chat.id],
                )
              }
              style={({ pressed }) => [
                styles.row,
                pressed && { backgroundColor: theme.surfaceSelected },
                disabled && styles.disabled,
              ]}
            >
              <Avatar
                name={title}
                seed={chat.avatar_seed || chat.id}
                size={40}
                shape={chat.kind === "direct" ? "circle" : "square"}
                glyph={chat.kind === "channel" ? "#" : undefined}
                agent={chat.direct_peer?.type === "agent"}
                {...chatAvatarSource(chat)}
              />
              <View style={styles.copy}>
                <Text weight="semibold" size={15.5} numberOfLines={1}>
                  {title}
                </Text>
                <Text tone="muted" size={13} numberOfLines={1}>
                  {metaOf(chat)}
                </Text>
              </View>
              <View
                style={[
                  styles.check,
                  checked
                    ? {
                        backgroundColor: theme.primary,
                        borderColor: theme.primary,
                      }
                    : { borderColor: theme.borderStrong },
                ]}
              >
                {checked && (
                  <Check size={14} color={theme.onPrimary} strokeWidth={2.6} />
                )}
              </View>
            </Pressable>
          );
        }}
      />
    </PageSheet>
  );
}

const styles = StyleSheet.create({
  send: {
    minHeight: 36,
    borderRadius: 10,
    paddingHorizontal: spacing[3],
    alignItems: "center",
    justifyContent: "center",
    maxWidth: 190,
  },
  quote: {
    borderLeftWidth: 3,
    paddingLeft: spacing[2],
    marginHorizontal: spacing[4],
    marginTop: spacing[3],
  },
  fields: { padding: spacing[4], gap: spacing[2] },
  field: {
    minHeight: 44,
    borderRadius: radius.lg,
    borderWidth: 1,
    paddingHorizontal: 13,
    fontFamily: fonts.regular,
    fontSize: 16,
  },
  search: {
    minHeight: 40,
    borderRadius: radius.lg,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[2],
    paddingHorizontal: spacing[3],
  },
  searchInput: {
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: 16,
    paddingVertical: spacing[2],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingVertical: 9,
  },
  disabled: { opacity: 0.45 },
  copy: { flex: 1, minWidth: 0 },
  check: {
    width: 22,
    height: 22,
    borderRadius: 7,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  empty: { textAlign: "center", padding: spacing[6] },
});
