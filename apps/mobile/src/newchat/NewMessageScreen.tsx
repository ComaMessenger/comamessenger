import { useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import {
  ChevronRight,
  Contact,
  Megaphone,
  Users,
  type LucideIcon,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { Notice } from "@/ui/Notice";
import { ScreenHeader } from "@/ui/ScreenHeader";
import { Text } from "@/ui/Text";
import { useOpenDirect } from "@/people/openDirect";
import { PersonRow, SearchField } from "@/people/PersonRow";
import { usePeople } from "@/people/usePeople";

function EntryRow({
  icon: Icon,
  label,
  hint,
  testID,
  onPress,
}: {
  icon: LucideIcon;
  label: string;
  hint?: string;
  testID: string;
  onPress(): void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityHint={hint}
      onPress={onPress}
      style={({ pressed }) => [
        styles.entry,
        pressed && { backgroundColor: theme.surfaceSelected },
      ]}
    >
      <View style={[styles.entryIcon, { backgroundColor: theme.primarySoft }]}>
        <Icon size={20} color={theme.primary} />
      </View>
      <Text weight="medium" size={16} style={styles.grow}>
        {label}
      </Text>
      <ChevronRight size={20} color={theme.subtle} />
    </Pressable>
  );
}

/**
 * «Новое сообщение»: pick a person or an agent to write to, or start a group
 * or a channel. The direct chat is the existing one when there is one.
 */
export function NewMessageScreen() {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const [query, setQuery] = useState("");
  const directory = usePeople({ query, locale: i18n.language });
  // Replace: «back» from the chat returns to the list, not to this picker.
  const direct = useOpenDirect((chatID) => router.replace(`/chat/${chatID}`));

  return (
    <SafeAreaView
      testID="new-message"
      edges={["bottom"]}
      style={[styles.screen, { backgroundColor: theme.surface }]}
    >
      <ScreenHeader backTestID="new-message-back" title={t("newMessage")} />
      <SearchField
        testID="new-message-search"
        value={query}
        onChange={setQuery}
        placeholder={t("newMessageSearch")}
      />
      <FlatList
        data={directory.people}
        keyExtractor={(person) => person.actor_id}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        onEndReached={directory.loadMore}
        onEndReachedThreshold={0.5}
        ListHeaderComponent={
          query.trim() ? null : (
            <View>
              <EntryRow
                testID="new-group"
                icon={Users}
                label={t("newGroup")}
                onPress={() => router.push("/new-chat/group?kind=group")}
              />
              <EntryRow
                testID="new-channel"
                icon={Megaphone}
                label={t("newChannel")}
                onPress={() => router.push("/new-chat/group?kind=channel")}
              />
              <EntryRow
                testID="open-people"
                icon={Contact}
                label={t("people")}
                onPress={() => router.push("/people")}
              />
              <Text
                tone="muted"
                size={13}
                weight="semibold"
                style={styles.caption}
              >
                {t("peopleAndAgents")}
              </Text>
            </View>
          )
        }
        renderItem={({ item, index }) => (
          <PersonRow
            testID={`new-message-person-${index}`}
            person={item}
            presence={directory.presence[item.actor_id]}
            busy={direct.opening === item.actor_id}
            hint={t("writeMessageHint")}
            onPress={() => void direct.open(item.actor_id)}
          />
        )}
        ListFooterComponent={
          directory.loadingMore || directory.searching ? (
            <ActivityIndicator style={styles.loader} color={theme.muted} />
          ) : null
        }
        ListEmptyComponent={
          directory.loading ? (
            <ActivityIndicator style={styles.loader} color={theme.muted} />
          ) : directory.failed ? (
            <View style={styles.state}>
              <Notice
                title={t("peopleLoadFailed")}
                actionLabel={t("retry")}
                onAction={directory.refetch}
              />
            </View>
          ) : directory.searching ? null : (
            <Text tone="muted" size={15} style={styles.state}>
              {t("peopleEmpty")}
            </Text>
          )
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  entry: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 56,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  entryIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  grow: { flex: 1 },
  caption: {
    paddingHorizontal: 14,
    paddingTop: spacing[4],
    paddingBottom: spacing[1],
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  loader: { marginVertical: spacing[6] },
  state: { padding: spacing[5] },
});
