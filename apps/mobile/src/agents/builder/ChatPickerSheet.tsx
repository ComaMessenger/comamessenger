import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Check } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { chatName, type Chat } from "@comamessenger/core";
import { spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { Avatar } from "@/ui/Avatar";
import { BottomSheet } from "@/ui/BottomSheet";
import { Divider } from "@/ui/Settings";
import { Text } from "@/ui/Text";
import { TextField } from "@/ui/TextField";

/**
 * Chats to add, several at once: a search and check marks, «Готово» on top.
 * Chats already chosen are not offered.
 */
export function ChatPickerSheet({
  visible,
  title,
  chats,
  exclude,
  onClose,
  onDone,
  single = false,
  testID = "agent-chat-picker",
}: {
  visible: boolean;
  title: string;
  chats: Chat[];
  exclude: readonly string[];
  onClose(): void;
  onDone(ids: string[]): void;
  /** One chat: a tap chooses it and closes the sheet. */
  single?: boolean;
  testID?: string;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const [chosen, setChosen] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (visible) {
      setChosen([]);
      setQuery("");
    }
  }, [visible]);
  const needle = query.trim().toLocaleLowerCase();
  const offered = chats.filter(
    (chat) =>
      !exclude.includes(chat.id) &&
      (!needle || chatName(chat).toLocaleLowerCase().includes(needle)),
  );
  return (
    <BottomSheet
      visible={visible}
      title={title}
      onClose={onClose}
      testID={testID}
      action={
        single
          ? undefined
          : {
              label: t("agentPickerDone"),
              disabled: chosen.length === 0,
              onPress: () => {
                onClose();
                onDone(chosen);
              },
            }
      }
    >
      {chats.length > 8 ? (
        <View style={styles.search}>
          <TextField
            label={t("agentChatSearch")}
            value={query}
            onChangeText={setQuery}
            placeholder={t("agentChatSearchPlaceholder")}
            autoCorrect={false}
          />
        </View>
      ) : null}
      {offered.length === 0 ? (
        <Text tone="muted" size={15} style={styles.empty}>
          {t("agentChatPickerEmpty")}
        </Text>
      ) : null}
      {offered.map((chat, index) => {
        const checked = chosen.includes(chat.id);
        return (
          <View key={chat.id}>
            {index > 0 && <Divider />}
            <Pressable
              testID={`${testID}-${chatName(chat)}`}
              accessibilityRole={single ? "button" : "checkbox"}
              accessibilityState={single ? undefined : { checked }}
              accessibilityLabel={chatName(chat)}
              onPress={() => {
                if (single) {
                  onClose();
                  onDone([chat.id]);
                  return;
                }
                setChosen((current) =>
                  checked
                    ? current.filter((id) => id !== chat.id)
                    : [...current, chat.id],
                );
              }}
              style={({ pressed }) => [
                styles.row,
                pressed && { backgroundColor: theme.surfaceSelected },
              ]}
            >
              <Avatar name={chatName(chat)} seed={chat.id} size={36} />
              <Text size={16} numberOfLines={1} style={styles.grow}>
                {chatName(chat)}
              </Text>
              {checked ? <Check size={20} color={theme.primary} /> : null}
            </Pressable>
          </View>
        );
      })}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  search: { paddingHorizontal: spacing[4], paddingBottom: spacing[2] },
  empty: { padding: spacing[4] },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[3],
    minHeight: 56,
    paddingHorizontal: spacing[4],
  },
  grow: { flex: 1 },
});
