import { useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, StyleSheet, View } from "react-native";
import { Check } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  filterPeople,
  orgIndex,
  orgNameMatches,
  personOrg,
  type ActorSummary,
  type OrgDepartment,
  type OrgStructure,
} from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { HeaderAction } from "@/knowledge/HeaderAction";
import { PersonRow, SearchField } from "@/people/PersonRow";
import { PageSheet } from "@/ui/PageSheet";
import { Text } from "@/ui/Text";
import { DepartmentIcon } from "./parts";

/** The round check of a single choice or the square one of several. */
function Mark({ on, round }: { on: boolean; round?: boolean }) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.mark,
        round && styles.round,
        on
          ? { backgroundColor: theme.primary, borderColor: theme.primary }
          : { borderColor: theme.borderStrong },
      ]}
    >
      {on ? (
        <Check size={14} strokeWidth={2.6} color={theme.onPrimary} />
      ) : null}
    </View>
  );
}

/**
 * Departments to choose from, as a tree with indents and search: «Входит
 * в», the primary or additional departments of a person, where members go
 * when a department is deleted. `none` adds a first row such as «Верхний
 * уровень» or «Без отдела».
 */
export function DepartmentPickerSheet({
  visible,
  title,
  structure,
  options,
  selected,
  multiple,
  none,
  max,
  onClose,
  onPick,
  testID,
}: {
  visible: boolean;
  title: string;
  structure: OrgStructure;
  /** Departments offered; all by default. */
  options?: readonly OrgDepartment[];
  selected: readonly (string | null)[];
  multiple?: boolean;
  /** A first row standing for «no department» (null). */
  none?: string;
  /** Most departments of a multiple choice. */
  max?: number;
  onClose(): void;
  /** One id (or null) for a single choice — the sheet closes; all for several. */
  onPick(ids: (string | null)[]): void;
  testID?: string;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<(string | null)[]>([...selected]);
  useEffect(() => {
    if (visible) {
      setChosen([...selected]);
      setQuery("");
    }
    // Reset only when the sheet opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);
  const index = useMemo(() => orgIndex(structure), [structure]);
  const rows = useMemo(() => {
    const allowed = options ? new Set(options.map((item) => item.id)) : null;
    const list = index.order.filter(
      (department) =>
        (!allowed || allowed.has(department.id)) &&
        orgNameMatches(department.name, query),
    );
    return [
      ...(none && !query.trim() ? [null] : []),
      ...list,
    ] as (OrgDepartment | null)[];
  }, [index, none, options, query]);
  const full = Boolean(max && chosen.length >= max);

  function press(id: string | null) {
    if (!multiple) {
      onPick([id]);
      onClose();
      return;
    }
    setChosen((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : full
          ? current
          : [...current, id],
    );
  }

  return (
    <PageSheet
      visible={visible}
      title={title}
      subtitle={full ? t("orgAdditionalLimit") : undefined}
      onClose={onClose}
      testID={testID}
      trailing={
        multiple ? (
          <HeaderAction
            testID={testID ? `${testID}-done` : undefined}
            label={t("orgDone")}
            onPress={() => {
              onPick(chosen);
              onClose();
            }}
          />
        ) : undefined
      }
    >
      <SearchField
        value={query}
        onChange={setQuery}
        placeholder={t("orgSearchDepartments")}
        testID={testID ? `${testID}-search` : undefined}
      />
      <FlatList
        data={rows}
        keyExtractor={(item) => item?.id ?? "none"}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        renderItem={({ item, index: position }) => {
          const id = item?.id ?? null;
          const on = chosen.includes(id);
          const depth =
            item && !query.trim() ? (index.depth.get(item.id) ?? 0) : 0;
          return (
            <Pressable
              testID={testID ? `${testID}-option-${position}` : undefined}
              accessibilityRole={multiple ? "checkbox" : "radio"}
              accessibilityState={{ checked: on }}
              accessibilityLabel={item?.name ?? none}
              onPress={() => press(id)}
              style={({ pressed }) => [
                styles.option,
                { paddingLeft: 14 + depth * 18 },
                pressed && { backgroundColor: theme.surfaceSelected },
              ]}
            >
              {item ? <DepartmentIcon /> : null}
              <Text size={15.5} numberOfLines={2} style={styles.grow}>
                {item?.name ?? none}
              </Text>
              <Mark on={on} round={!multiple} />
            </Pressable>
          );
        }}
      />
    </PageSheet>
  );
}

/**
 * People of the workspace with checkboxes and search; agents are never in
 * the structure, the reader is offered too (unlike the chat pickers).
 */
export function PersonPickerSheet({
  visible,
  title,
  people,
  structure,
  selected,
  onClose,
  onPick,
  testID,
}: {
  visible: boolean;
  title: string;
  people: readonly ActorSummary[];
  structure: OrgStructure;
  selected: readonly string[];
  onClose(): void;
  onPick(ids: string[]): void;
  testID?: string;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<string[]>([...selected]);
  useEffect(() => {
    if (visible) {
      setChosen([...selected]);
      setQuery("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);
  const list = useMemo(
    () =>
      filterPeople(people, { query, filter: "people", structure }).sort(
        (left, right) => left.display_name.localeCompare(right.display_name),
      ),
    [people, query, structure],
  );
  return (
    <PageSheet
      visible={visible}
      title={title}
      subtitle={t("orgSelected", { count: chosen.length })}
      onClose={onClose}
      testID={testID}
      trailing={
        <HeaderAction
          testID={testID ? `${testID}-done` : undefined}
          label={t("orgDone")}
          onPress={() => {
            onPick(chosen);
            onClose();
          }}
        />
      }
    >
      <SearchField
        value={query}
        onChange={setQuery}
        placeholder={t("peopleSearch")}
        testID={testID ? `${testID}-search` : undefined}
      />
      <FlatList
        data={list}
        keyExtractor={(item) => item.actor_id}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        renderItem={({ item, index }) => {
          const primary = personOrg(structure, item.actor_id).primary;
          return (
            <PersonRow
              testID={testID ? `${testID}-person-${index}` : undefined}
              person={item}
              meta={primary ? primary.name : t("orgNoDepartment")}
              selected={chosen.includes(item.actor_id)}
              onPress={() =>
                setChosen((current) =>
                  current.includes(item.actor_id)
                    ? current.filter((id) => id !== item.actor_id)
                    : [...current, item.actor_id],
                )
              }
            />
          );
        }}
      />
    </PageSheet>
  );
}

/** One position, «Без должности» first. */
export function PositionPickerSheet({
  visible,
  structure,
  selected,
  onClose,
  onPick,
  testID,
}: {
  visible: boolean;
  structure: OrgStructure;
  selected: string | null;
  onClose(): void;
  onPick(id: string | null): void;
  testID?: string;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (visible) setQuery("");
  }, [visible]);
  const rows = useMemo(
    () => [
      ...(query.trim() ? [] : [null]),
      ...orgIndex(structure).positionOrder.filter((position) =>
        orgNameMatches(position.name, query),
      ),
    ],
    [query, structure],
  );
  return (
    <PageSheet
      visible={visible}
      title={t("orgMemberPosition")}
      onClose={onClose}
      testID={testID}
    >
      <SearchField
        value={query}
        onChange={setQuery}
        placeholder={t("orgSearchPositions")}
      />
      <FlatList
        data={rows}
        keyExtractor={(item) => item?.id ?? "none"}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item, index }) => {
          const id = item?.id ?? null;
          return (
            <Pressable
              testID={testID ? `${testID}-option-${index}` : undefined}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected === id }}
              onPress={() => {
                onPick(id);
                onClose();
              }}
              style={({ pressed }) => [
                styles.option,
                pressed && { backgroundColor: theme.surfaceSelected },
              ]}
            >
              <Text size={15.5} style={styles.grow}>
                {item?.name ?? t("orgNoPosition")}
              </Text>
              <Mark on={selected === id} round />
            </Pressable>
          );
        }}
      />
    </PageSheet>
  );
}

const styles = StyleSheet.create({
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingRight: spacing[4],
    paddingVertical: 8,
    minHeight: 52,
  },
  grow: { flex: 1, minWidth: 0 },
  mark: {
    width: 22,
    height: 22,
    borderRadius: 7,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  round: { borderRadius: radius.full },
});
