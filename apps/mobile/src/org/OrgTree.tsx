import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { ChevronDown, Search, X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  buildOrgTree,
  departmentCount,
  departmentPath,
  filterPeople,
  flattenOrgTree,
  personOrg,
  personOrgLine,
  positionPeople,
  searchOrg,
  type OrgTreeRow,
} from "@comamessenger/core";
import { spacing } from "@comamessenger/tokens";
import { cacheStorage } from "@/lib/database";
import { useTheme } from "@/lib/theme";
import { useSignedIn } from "@/session/SessionProvider";
import { PersonRow, SearchField } from "@/people/PersonRow";
import { Avatar } from "@/ui/Avatar";
import { Button } from "@/ui/Button";
import { IconButton } from "@/ui/IconButton";
import { Notice } from "@/ui/Notice";
import { ScreenHeader } from "@/ui/ScreenHeader";
import { Text } from "@/ui/Text";
import { DepartmentIcon, InfoGroup, KVRow } from "./parts";
import { personName, useAllPeople, useOrg } from "./useOrg";

/** Collapsed branches survive a restart (decision: state in storage). */
const collapsedKey = "org:tree-collapsed";
const indent = 16;

/**
 * «Ещё → Оргструктура» (tab D of the prototype): a compact tree where the
 * indent and a line show nesting, the lead is under the name and the number
 * on the right counts people with subdepartments. The arrow collapses a
 * branch, the name opens the department card. Search in the header finds
 * departments, positions and people.
 */
export function OrgTreeScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const { user } = useSignedIn();
  const org = useOrg();
  const everyone = useAllPeople();
  const structure = org.structure;
  const [collapsed, setCollapsed] = useState<ReadonlySet<string> | null>(null);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    cacheStorage
      .get<string[]>(collapsedKey)
      .then((ids) => setCollapsed(new Set(ids ?? [])))
      .catch(() => setCollapsed(new Set()));
  }, []);

  const tree = useMemo(
    () => (structure ? buildOrgTree(structure) : []),
    [structure],
  );
  const rows = useMemo(() => {
    if (!structure) return [];
    const hidden = collapsed ?? new Set<string>();
    const open = new Set(
      structure.departments
        .map((department) => department.id)
        .filter((id) => !hidden.has(id)),
    );
    return flattenOrgTree(tree, open);
  }, [collapsed, structure, tree]);

  function toggle(id: string) {
    setCollapsed((current) => {
      const next = new Set(current ?? []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      void cacheStorage.set(collapsedKey, [...next]).catch(() => undefined);
      return next;
    });
  }

  const needle = query.trim();
  const found = useMemo(() => {
    if (!structure || !needle) return null;
    const result = searchOrg(structure, needle);
    const people = filterPeople(everyone.people, {
      query: needle,
      filter: "people",
      structure,
    }).slice(0, 30);
    return { ...result, people };
  }, [everyone.people, needle, structure]);

  return (
    <SafeAreaView
      testID="org-tree"
      edges={["bottom"]}
      style={[styles.screen, { backgroundColor: theme.surface }]}
    >
      <ScreenHeader
        backTestID="org-tree-back"
        title={t("orgTitle")}
        subtitle={user.organization_name}
        trailing={
          structure?.departments.length ? (
            <IconButton
              testID="org-tree-search"
              label={searching ? t("close") : t("orgSearchOpen")}
              onPress={() => {
                setSearching(!searching);
                setQuery("");
              }}
              icon={(color) =>
                searching ? (
                  <X size={20} color={color} />
                ) : (
                  <Search size={20} color={color} />
                )
              }
            />
          ) : undefined
        }
      />
      {searching ? (
        <SearchField
          testID="org-tree-query"
          value={query}
          onChange={setQuery}
          placeholder={t("orgTreeSearch")}
          autoFocus
        />
      ) : null}
      {!org.available ? null : org.loading || collapsed === null ? (
        <ActivityIndicator style={styles.loader} color={theme.muted} />
      ) : org.failed || !structure ? (
        <View style={styles.state}>
          <Notice
            title={t("orgLoadFailed")}
            actionLabel={t("retry")}
            onAction={org.refetch}
          />
        </View>
      ) : !structure.departments.length ? (
        <View style={styles.state} testID="org-tree-empty">
          <Text weight="semibold" size={16} style={styles.center}>
            {org.canManage ? t("orgTreeEmptyManage") : t("orgTreeEmpty")}
          </Text>
          <Text tone="muted" size={14} style={styles.center}>
            {org.canManage
              ? t("orgTreeEmptyManageHint")
              : t("orgTreeEmptyHint")}
          </Text>
          {org.canManage ? (
            <Button
              testID="org-tree-settings"
              label={t("orgOpenSettings")}
              onPress={() => router.push("/settings/workspace/org" as never)}
            />
          ) : null}
        </View>
      ) : found ? (
        <ScrollView
          testID="org-tree-results"
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          style={{ backgroundColor: theme.canvas }}
        >
          {found.departments.length ? (
            <InfoGroup title={t("orgSearchDepartments")}>
              {found.departments.map(({ department, path }, index) => (
                <KVRow
                  key={department.id}
                  first={index === 0}
                  testID={`org-found-department-${index}`}
                  leading={<DepartmentIcon />}
                  title={department.name}
                  caption={t("orgPathCount", {
                    path: path || t("orgTopLevel"),
                    count: departmentCount(structure, department.id),
                  })}
                  onPress={() => router.push(`/org/${department.id}` as never)}
                />
              ))}
            </InfoGroup>
          ) : null}
          {found.positions.length ? (
            <InfoGroup title={t("orgSearchPositions")}>
              {found.positions.map((position, index) => (
                <KVRow
                  key={position.id}
                  first={index === 0}
                  title={position.name}
                  caption={t("orgPositionPeople", {
                    count: positionPeople(structure, position.id).length,
                  })}
                />
              ))}
            </InfoGroup>
          ) : null}
          {found.people.length ? (
            <InfoGroup title={t("orgSearchPeople")}>
              {found.people.map((person, index) => {
                const primary = personOrg(structure, person.actor_id).primary;
                return (
                  <PersonRow
                    key={person.actor_id}
                    testID={`org-found-person-${index}`}
                    person={person}
                    meta={[
                      personOrgLine(person, structure),
                      primary ? departmentPath(structure, primary.id) : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                    onPress={() => router.push(`/people/${person.actor_id}`)}
                  />
                );
              })}
            </InfoGroup>
          ) : null}
          {!found.departments.length &&
          !found.positions.length &&
          !found.people.length ? (
            <View style={styles.state}>
              <Text tone="muted" size={15} style={styles.center}>
                {t("orgSearchEmpty")}
              </Text>
            </View>
          ) : null}
        </ScrollView>
      ) : (
        <FlatList
          testID="org-tree-list"
          data={rows}
          keyExtractor={(row) => row.node.department.id}
          contentContainerStyle={styles.tree}
          renderItem={({ item, index }) => (
            <TreeRow
              row={item}
              index={index}
              lead={personName(
                everyone.byID,
                item.node.department.lead_actor_id,
              )}
              onToggle={() => toggle(item.node.department.id)}
            />
          )}
          ListFooterComponent={
            <Text tone="muted" size={12.5} style={styles.caption}>
              {t("orgTreeCaption")}
            </Text>
          }
        />
      )}
    </SafeAreaView>
  );
}

function TreeRow({
  row,
  index,
  lead,
  onToggle,
}: {
  row: OrgTreeRow;
  index: number;
  lead: string;
  onToggle(): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { department, count } = row.node;
  const leadLine = lead || t("orgNoLead");
  return (
    <View style={[styles.row, { paddingLeft: 2 + row.depth * indent }]}>
      {Array.from({ length: row.depth }, (_, level) => (
        <View
          key={level}
          style={[
            styles.line,
            { left: 2 + level * indent + 10, backgroundColor: theme.border },
          ]}
        />
      ))}
      <Pressable
        testID={row.hasChildren ? `org-tree-toggle-${index}` : undefined}
        accessibilityRole={row.hasChildren ? "button" : undefined}
        accessibilityLabel={
          row.hasChildren
            ? `${row.expanded ? t("orgCollapse") : t("orgExpand")}: ${department.name}`
            : undefined
        }
        accessibilityState={
          row.hasChildren ? { expanded: row.expanded } : undefined
        }
        disabled={!row.hasChildren}
        onPress={onToggle}
        hitSlop={8}
        style={styles.twisty}
      >
        {row.hasChildren ? (
          <ChevronDown
            size={16}
            color={theme.muted}
            style={row.expanded ? undefined : styles.closed}
          />
        ) : null}
      </Pressable>
      <Pressable
        testID={`org-tree-row-${index}`}
        accessibilityRole="button"
        accessibilityLabel={`${department.name}, ${leadLine}, ${t("orgEmployees", { count })}`}
        accessibilityHint={t("orgOpenDepartmentHint")}
        onPress={() => router.push(`/org/${department.id}` as never)}
        style={({ pressed }) => [
          styles.node,
          pressed && { backgroundColor: theme.surfaceSelected },
        ]}
      >
        <View style={styles.grow}>
          <Text weight="semibold" size={14.5} numberOfLines={2}>
            {department.name}
          </Text>
          <View style={styles.leadLine}>
            {department.lead_actor_id && lead ? (
              <Avatar
                name={lead}
                seed={department.lead_actor_id}
                actorID={department.lead_actor_id}
                size={16}
              />
            ) : null}
            <Text tone="muted" size={12} numberOfLines={1} style={styles.grow}>
              {leadLine}
            </Text>
          </View>
        </View>
        <View
          style={[styles.count, { backgroundColor: theme.surfaceSelected }]}
        >
          <Text tone="muted" size={12} weight="bold">
            {count}
          </Text>
        </View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  loader: { marginTop: spacing[8] },
  state: { padding: spacing[5], gap: spacing[3] },
  center: { textAlign: "center" },
  // Prototype: `.tree { padding: 8px 6px 14px }`.
  tree: { paddingTop: 8, paddingHorizontal: 6, paddingBottom: 14 },
  // Prototype: `.tn { gap: 4px; padding: 6px 8px 6px 2px; border-radius: 12px }`.
  row: { flexDirection: "row", alignItems: "center", gap: 4 },
  line: { position: "absolute", top: 0, bottom: 0, width: 1.5 },
  twisty: {
    width: 22,
    height: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  closed: { transform: [{ rotate: "-90deg" }] },
  node: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 6,
    paddingRight: 8,
    paddingLeft: 2,
    borderRadius: 12,
    minHeight: 48,
  },
  grow: { flex: 1, minWidth: 0 },
  leadLine: { flexDirection: "row", alignItems: "center", gap: 5 },
  // Prototype: `.cnt { font-size: 12px; font-weight: 700; border-radius: 8px; padding: 2px 7px }`.
  count: { borderRadius: 8, paddingHorizontal: 7, paddingVertical: 2 },
  caption: { paddingHorizontal: 16, paddingTop: 10 },
});
