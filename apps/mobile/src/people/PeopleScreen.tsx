import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { ListFilter, UserPlus } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  departmentPath,
  personOrg,
  personOrgLine,
  type PeopleFilter,
} from "@comamessenger/core";
import { spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { useSignedIn } from "@/session/SessionProvider";
import { IconButton } from "@/ui/IconButton";
import { MenuSheet } from "@/ui/MenuSheet";
import { Notice } from "@/ui/Notice";
import {
  PeopleByDepartment,
  type OrgPeopleView,
} from "@/org/PeopleByDepartment";
import { useAllPeople, useOrg } from "@/org/useOrg";
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
  const org = useOrg();
  const structure = org.structure;
  // With departments the chips become departments (phase 6.5 wave 2).
  const grouped = Boolean(structure?.departments.length);
  const [view, setView] = useState<OrgPeopleView>("all");
  const [department, setDepartment] = useState<string | null | undefined>();
  const [menu, setMenu] = useState(false);
  const everyone = useAllPeople();
  const directory = usePeople({
    query,
    filter: grouped
      ? view === "agents"
        ? "agents"
        : view === "online"
          ? "online"
          : "all"
      : filter,
    locale: i18n.language,
    structure,
  });
  const { counts } = directory;
  const unassigned = useMemo(
    () =>
      structure
        ? everyone.people.some(
            (person) =>
              person.type === "user" &&
              !personOrg(structure, person.actor_id).primary,
          )
        : false,
    [everyone.people, structure],
  );
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
            : grouped && structure
              ? t("orgPeopleCounts", {
                  humans: everyone.people.filter(
                    (person) => person.type === "user",
                  ).length,
                  departments: structure.departments.length,
                })
              : t("peopleCounts", {
                  humans: counts.humans,
                  agents: counts.agents,
                })
        }
        trailing={
          user.can_create_invitations || grouped ? (
            <View style={styles.actions}>
              {grouped ? (
                <IconButton
                  testID="people-menu"
                  label={t("orgPeopleFilters")}
                  variant={view === "all" ? "plain" : "soft"}
                  onPress={() => setMenu(true)}
                  icon={(color) => <ListFilter size={20} color={color} />}
                />
              ) : null}
              {user.can_create_invitations ? (
                <IconButton
                  testID="people-invite"
                  label={t("peopleInvite")}
                  hint={t("peopleInviteHint")}
                  variant="soft"
                  onPress={() => router.push("/settings/workspace/invitations")}
                  icon={(color) => <UserPlus size={20} color={color} />}
                />
              ) : null}
            </View>
          ) : undefined
        }
      />
      <SearchField
        testID="people-search"
        value={query}
        onChange={setQuery}
        placeholder={t("peopleSearch")}
      />
      {grouped && structure ? (
        <>
          {view !== "agents" ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              accessibilityRole="tablist"
              style={styles.chipsScroll}
              contentContainerStyle={styles.chips}
            >
              <TabChip
                testID="people-dept-all"
                label={t("peopleFilterAll")}
                selected={department === undefined}
                onPress={() => setDepartment(undefined)}
              />
              {org.order.map((item) => (
                <TabChip
                  key={item.id}
                  testID={`people-dept-${item.id}`}
                  label={item.name}
                  selected={department === item.id}
                  onPress={() => setDepartment(item.id)}
                />
              ))}
              {unassigned ? (
                <TabChip
                  testID="people-dept-none"
                  label={t("orgNoDepartment")}
                  selected={department === null}
                  onPress={() => setDepartment(null)}
                />
              ) : null}
            </ScrollView>
          ) : null}
          {query.trim() ? (
            <FlatList
              testID="people-list"
              data={directory.people}
              keyExtractor={(person) => person.actor_id}
              keyboardDismissMode="on-drag"
              keyboardShouldPersistTaps="handled"
              renderItem={({ item, index }) => {
                const where = personOrg(structure, item.actor_id).primary;
                return (
                  <PersonRow
                    testID={`person-row-${index}`}
                    person={item}
                    presence={directory.presence[item.actor_id]}
                    meta={
                      item.type === "user"
                        ? [
                            personOrgLine(item, structure),
                            where ? departmentPath(structure, where.id) : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")
                        : undefined
                    }
                    hint={t("openProfileHint")}
                    onPress={() => router.push(`/people/${item.actor_id}`)}
                  />
                );
              }}
              ListFooterComponent={
                directory.searching ? (
                  <ActivityIndicator
                    style={styles.loader}
                    color={theme.muted}
                  />
                ) : null
              }
              ListEmptyComponent={
                directory.searching ? null : (
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
          ) : everyone.failed ? (
            <View style={styles.state}>
              <Notice
                title={t("peopleLoadFailed")}
                actionLabel={t("retry")}
                onAction={everyone.refetch}
              />
            </View>
          ) : (
            <PeopleByDepartment
              people={everyone.people}
              structure={structure}
              presence={directory.presence}
              view={view}
              departmentID={view === "agents" ? undefined : department}
              loading={everyone.loading && everyone.people.length === 0}
            />
          )}
          <MenuSheet
            visible={menu}
            title={t("orgPeopleFilters")}
            testID="people-menu-sheet"
            onClose={() => setMenu(false)}
            items={(
              [
                ["all", t("orgFilterEveryone")],
                ["online", t("peopleFilterOnline")],
                ["agents", t("peopleFilterAgents")],
              ] as const
            ).map(([value, label]) => ({
              key: value,
              label,
              meta:
                value === "online"
                  ? String(counts.online)
                  : value === "agents"
                    ? String(counts.agents)
                    : undefined,
              checked: view === value,
              testID: `people-view-${value}`,
              onPress: () => {
                setView(value);
                setMenu(false);
              },
            }))}
          />
        </>
      ) : (
        <>
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
        </>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  actions: { flexDirection: "row", gap: 4 },
  chipsScroll: { flexGrow: 0 },
  chips: { gap: 6, paddingHorizontal: 14, paddingBottom: 10 },
  loader: { marginVertical: spacing[6] },
  state: { padding: spacing[5], gap: spacing[2] },
  center: { textAlign: "center" },
});
