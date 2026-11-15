import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import { router } from "expo-router";
import { Bot, ChevronDown, UserRound } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  groupPeopleByDepartment,
  personOrgLine,
  type ActorSummary,
  type OrgStructure,
  type PeopleGroup,
  type PersonPresence,
} from "@comamessenger/core";
import { spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { PersonRow } from "@/people/PersonRow";
import { Text } from "@/ui/Text";
import { DepartmentIcon, OrgTag } from "./parts";

/** «Онлайн» and «Агенты» moved from the chips to the header menu. */
export type OrgPeopleView = "all" | "online" | "agents";

type Row =
  | {
      kind: "head";
      key: string;
      group: PeopleGroup<ActorSummary> | { kind: "agents"; count: number };
      collapsed: boolean;
      count: number;
    }
  | {
      kind: "person";
      key: string;
      person: ActorSummary;
      lead: boolean;
      additional: boolean;
      /** Position among people rows, for test ids. */
      n: number;
    };

const groupKey = (group: Row & { kind: "head" }) =>
  group.group.kind === "department" ? group.group.department.id : group.key;

/**
 * «Люди» grouped by department (tab A of the prototype): a header with the
 * department square, its path and count that opens the card and collapses
 * the group; the lead first with «рук.», additional members with «совм.»,
 * «Без отдела» at the end and agents apart.
 */
export function PeopleByDepartment({
  people,
  structure,
  presence,
  view,
  departmentID,
  loading,
  header,
}: {
  people: readonly ActorSummary[];
  structure: OrgStructure;
  presence: Readonly<Record<string, PersonPresence>>;
  view: OrgPeopleView;
  /** undefined — every department; null — «Без отдела»; else a department with its subdepartments. */
  departmentID: string | null | undefined;
  loading: boolean;
  header?: React.ReactElement;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  const rows = useMemo(() => {
    const result: Row[] = [];
    const agents = people.filter((person) => person.type === "agent");
    if (view !== "agents") {
      const shown =
        view === "online"
          ? people.filter(
              (person) =>
                person.type === "user" &&
                presence[person.actor_id] === "online",
            )
          : people;
      const groups = groupPeopleByDepartment(shown, structure, {
        departmentID,
      });
      for (const group of groups) {
        const key =
          group.kind === "department"
            ? group.department.id
            : "group-no-department";
        const closed = collapsed.has(key);
        result.push({
          kind: "head",
          key,
          group,
          collapsed: closed,
          count: group.entries.length,
        });
        if (closed) continue;
        for (const entry of group.entries)
          result.push({
            kind: "person",
            key: `${key}:${entry.person.actor_id}`,
            person: entry.person,
            lead: entry.lead,
            additional: entry.additional,
            n: 0,
          });
      }
    }
    if (
      (view === "all" && departmentID === undefined && agents.length) ||
      view === "agents"
    ) {
      const key = "group-agents";
      const closed = view === "all" && collapsed.has(key);
      if (view === "all")
        result.push({
          kind: "head",
          key,
          group: { kind: "agents", count: agents.length },
          collapsed: closed,
          count: agents.length,
        });
      if (!closed)
        for (const agent of agents)
          result.push({
            kind: "person",
            key: `agent:${agent.actor_id}`,
            person: agent,
            lead: false,
            additional: false,
            n: 0,
          });
    }
    let n = 0;
    for (const row of result) if (row.kind === "person") row.n = n++;
    return result;
  }, [collapsed, departmentID, people, presence, structure, view]);

  function toggle(key: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <FlatList
      testID="people-list"
      data={rows}
      keyExtractor={(row) => row.key}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={header}
      renderItem={({ item, index }) => {
        if (item.kind === "person")
          return (
            <PersonRow
              testID={`person-row-${item.n}`}
              person={item.person}
              presence={presence[item.person.actor_id]}
              meta={
                item.person.type === "user"
                  ? personOrgLine(item.person, structure)
                  : undefined
              }
              tags={
                item.lead ? (
                  <OrgTag kind="lead" />
                ) : item.additional ? (
                  <OrgTag kind="additional" />
                ) : null
              }
              hint={t("openProfileHint")}
              onPress={() => router.push(`/people/${item.person.actor_id}`)}
            />
          );
        const group = item.group;
        const department = group.kind === "department" ? group : null;
        const title =
          group.kind === "department"
            ? group.department.name
            : group.kind === "none"
              ? t("orgNoDepartment")
              : t("orgAgentsGroup");
        const caption = department
          ? t("orgPathCount", {
              path: department.path || t("orgTopLevel"),
              count: item.count,
            })
          : t("orgPeopleShort", { count: item.count });
        const key = groupKey(item);
        return (
          <View
            testID={`people-group-${department ? department.department.id : key}`}
            style={styles.head}
          >
            <Pressable
              testID={department ? `people-group-open-${index}` : undefined}
              accessibilityRole={department ? "button" : "header"}
              accessibilityLabel={`${title}, ${caption}`}
              accessibilityHint={
                department ? t("orgOpenDepartmentHint") : undefined
              }
              disabled={!department}
              onPress={() =>
                department &&
                router.push(`/org/${department.department.id}` as never)
              }
              style={({ pressed }) => [
                styles.headBody,
                pressed && styles.pressed,
              ]}
            >
              {department ? (
                <DepartmentIcon />
              ) : (
                <View
                  style={[
                    styles.plainIcon,
                    { backgroundColor: theme.surfaceSelected },
                  ]}
                >
                  {group.kind === "agents" ? (
                    <Bot size={16} color={theme.muted} />
                  ) : (
                    <UserRound size={16} color={theme.muted} />
                  )}
                </View>
              )}
              <View style={styles.grow}>
                <Text weight="semibold" size={14.5} numberOfLines={1}>
                  {title}
                </Text>
                <Text tone="muted" size={12} numberOfLines={1}>
                  {caption}
                </Text>
              </View>
            </Pressable>
            <Pressable
              testID={`people-group-toggle-${index}`}
              accessibilityRole="button"
              accessibilityLabel={`${item.collapsed ? t("orgExpand") : t("orgCollapse")}: ${title}`}
              accessibilityState={{ expanded: !item.collapsed }}
              onPress={() => toggle(key)}
              hitSlop={6}
              style={styles.toggle}
            >
              <ChevronDown
                size={16}
                color={theme.muted}
                style={item.collapsed ? styles.closed : undefined}
              />
            </Pressable>
          </View>
        );
      }}
      ListEmptyComponent={
        loading ? (
          <ActivityIndicator style={styles.loader} color={theme.muted} />
        ) : (
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
      ListFooterComponent={<View style={styles.footer} />}
    />
  );
}

const styles = StyleSheet.create({
  // Prototype: `.dhd { gap: 10px; padding: 12px 10px 6px 14px }`.
  head: {
    flexDirection: "row",
    alignItems: "center",
    paddingTop: 12,
    paddingRight: 10,
    paddingBottom: 6,
    paddingLeft: 14,
  },
  headBody: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 40,
  },
  pressed: { opacity: 0.6 },
  plainIcon: {
    width: 30,
    height: 30,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  grow: { flex: 1, minWidth: 0 },
  toggle: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  closed: { transform: [{ rotate: "-90deg" }] },
  loader: { marginVertical: spacing[6] },
  state: { padding: spacing[5], gap: spacing[2] },
  center: { textAlign: "center" },
  footer: { height: spacing[6] },
});
