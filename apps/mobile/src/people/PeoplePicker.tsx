import { useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { ActorSummary } from "@comamessenger/core";
import { spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { ChatAvatar } from "@/chats/ChatAvatar";
import { Notice } from "@/ui/Notice";
import { Text } from "@/ui/Text";
import { PersonRow, SearchField } from "./PersonRow";
import { usePeople } from "./usePeople";

/**
 * Multi-select of people and agents: search, the chosen ones as chips that
 * remove on tap, and the directory with checkboxes.
 */
export function PeoplePicker({
  selected,
  onChange,
  exclude = [],
  testID,
}: {
  selected: ActorSummary[];
  onChange(next: ActorSummary[]): void;
  /** Already in the chat: not offered. */
  exclude?: readonly string[];
  testID?: string;
}) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const [query, setQuery] = useState("");
  const directory = usePeople({ query, exclude, locale: i18n.language });
  const chosen = new Set(selected.map((actor) => actor.actor_id));

  function toggle(actor: ActorSummary) {
    onChange(
      chosen.has(actor.actor_id)
        ? selected.filter((item) => item.actor_id !== actor.actor_id)
        : [...selected, actor],
    );
  }

  return (
    <View style={styles.grow} testID={testID}>
      <SearchField
        testID={testID ? `${testID}-search` : undefined}
        value={query}
        onChange={setQuery}
        placeholder={t("peopleSearch")}
      />
      {selected.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.chipsScroll}
          contentContainerStyle={styles.chips}
          accessibilityLabel={t("chosenPeople", { count: selected.length })}
        >
          {selected.map((actor) => (
            <Pressable
              key={actor.actor_id}
              accessibilityRole="button"
              accessibilityLabel={t("removeChosen", {
                name: actor.display_name,
              })}
              onPress={() => toggle(actor)}
              style={[styles.chip, { backgroundColor: theme.primarySoft }]}
            >
              <ChatAvatar
                name={actor.display_name}
                seed={actor.actor_id}
                actorID={actor.actor_id}
                avatarVersion={actor.avatar_version}
                size={24}
                shape="circle"
                agent={actor.type === "agent"}
              />
              <Text
                size={14}
                weight="medium"
                numberOfLines={1}
                style={[styles.chipName, { color: theme.primary }]}
              >
                {actor.display_name}
              </Text>
              <X size={14} color={theme.primary} />
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      <FlatList
        data={directory.people}
        keyExtractor={(person) => person.actor_id}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        onEndReached={directory.loadMore}
        onEndReachedThreshold={0.5}
        renderItem={({ item, index }) => (
          <PersonRow
            testID={testID ? `${testID}-row-${index}` : undefined}
            person={item}
            presence={directory.presence[item.actor_id]}
            selected={chosen.has(item.actor_id)}
            onPress={() => toggle(item)}
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
    </View>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1 },
  chipsScroll: { flexGrow: 0 },
  chips: { gap: 6, paddingHorizontal: 14, paddingBottom: 10 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 34,
    maxWidth: 200,
    paddingLeft: 5,
    paddingRight: 10,
    borderRadius: 17,
  },
  chipName: { flexShrink: 1 },
  loader: { marginVertical: spacing[6] },
  state: { padding: spacing[5] },
});
