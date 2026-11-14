import { useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { UserPlus } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { PeopleFilter } from "@comamessenger/core";
import { spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { useSignedIn } from "@/session/SessionProvider";
import { IconButton } from "@/ui/IconButton";
import { Notice } from "@/ui/Notice";
import { ScreenHeader } from "@/ui/ScreenHeader";
import { TabChip } from "@/ui/TabChip";
import { Text } from "@/ui/Text";
import { PersonRow, SearchField } from "./PersonRow";
import { usePeople } from "./usePeople";

/** «Люди»: everyone in the workspace, people and agents, with search and filters. */
export function PeopleScreen() {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const { user } = useSignedIn();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PeopleFilter>("all");
  const directory = usePeople({ query, filter, locale: i18n.language });
  const { counts } = directory;
  const filters: { value: PeopleFilter; label: string }[] = [
    { value: "all", label: t("peopleFilterAll") },
    { value: "online", label: t("peopleFilterOnline") },
    { value: "people", label: t("peopleFilterPeople") },
    { value: "agents", label: t("peopleFilterAgents") },
  ];

  return (
    <SafeAreaView
      testID="people"
      edges={["bottom"]}
      style={[styles.screen, { backgroundColor: theme.surface }]}
    >
      <ScreenHeader
        backTestID="people-back"
        title={t("people")}
        subtitle={
          directory.loading
            ? undefined
            : t("peopleCounts", {
                humans: counts.humans,
                agents: counts.agents,
              })
        }
        trailing={
          user.can_create_invitations ? (
            <IconButton
              testID="people-invite"
              label={t("peopleInvite")}
              hint={t("peopleInviteHint")}
              variant="soft"
              onPress={() => router.push("/settings/workspace/invitations")}
              icon={(color) => <UserPlus size={20} color={color} />}
            />
          ) : undefined
        }
      />
      <SearchField
        testID="people-search"
        value={query}
        onChange={setQuery}
        placeholder={t("peopleSearch")}
      />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        accessibilityRole="tablist"
        style={styles.chipsScroll}
        contentContainerStyle={styles.chips}
      >
        {filters.map((item) => (
          <TabChip
            key={item.value}
            testID={`people-filter-${item.value}`}
            label={item.label}
            count={item.value === "online" ? counts.online : undefined}
            selected={filter === item.value}
            onPress={() => setFilter(item.value)}
          />
        ))}
      </ScrollView>
      <FlatList
        testID="people-list"
        data={directory.people}
        keyExtractor={(person) => person.actor_id}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        onEndReached={directory.loadMore}
        onEndReachedThreshold={0.5}
        renderItem={({ item, index }) => (
          <PersonRow
            testID={`person-row-${index}`}
            person={item}
            presence={directory.presence[item.actor_id]}
            hint={t("openProfileHint")}
            onPress={() => router.push(`/people/${item.actor_id}`)}
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
            <View style={styles.state}>
              <Text weight="semibold" size={16} style={styles.center}>
                {t("peopleEmpty")}
              </Text>
              <Text tone="muted" size={14} style={styles.center}>
                {t("peopleEmptyHint")}
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
  chipsScroll: { flexGrow: 0 },
  chips: { gap: 6, paddingHorizontal: 14, paddingBottom: 10 },
  loader: { marginVertical: spacing[6] },
  state: { padding: spacing[5], gap: spacing[2] },
  center: { textAlign: "center" },
});
