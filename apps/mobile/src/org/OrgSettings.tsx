import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { router } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  Briefcase,
  Check,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  UserRoundX,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  departmentCount,
  departmentMoves,
  orgIndex,
  peopleWithoutDepartment,
  personOrgLine,
  positionPeople,
  type OrgDepartment,
  type OrgPosition,
} from "@comamessenger/core";
import { spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { useSignedIn } from "@/session/SessionProvider";
import { HeaderAction } from "@/knowledge/HeaderAction";
import { PersonRow } from "@/people/PersonRow";
import { SettingsScreen } from "@/settings/SettingsScreen";
import { Button } from "@/ui/Button";
import { IconButton } from "@/ui/IconButton";
import { MenuSheet, afterSheetCloses } from "@/ui/MenuSheet";
import { Notice } from "@/ui/Notice";
import { PageSheet } from "@/ui/PageSheet";
import {
  ActionRow,
  Divider,
  GroupBody,
  NavRow,
  SettingsGroup,
} from "@/ui/Settings";
import { Text } from "@/ui/Text";
import { TextField } from "@/ui/TextField";
import { DeleteDepartmentSheet } from "./DeleteDepartmentSheet";
import { DepartmentEditor } from "./DepartmentEditor";
import { DepartmentIcon, orgErrorText } from "./parts";
import { DepartmentPickerSheet, PositionPickerSheet } from "./pickers";
import { personName, useAllPeople, useOrg, useOrgRefresh } from "./useOrg";

/**
 * «Настройки → Пространство → Оргструктура» (tab E): departments with
 * their nesting, «+ Отдел», the menu of a department («Изменить», «Выше»,
 * «Ниже», «Удалить»), then «Должности» and «Без отдела».
 */
export function OrgSettingsScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const { api } = useSignedIn();
  const org = useOrg();
  const refresh = useOrgRefresh();
  const everyone = useAllPeople();
  const structure = org.structure;
  const [editing, setEditing] = useState<{ id: string | null } | null>(null);
  const [menuFor, setMenuFor] = useState<OrgDepartment | null>(null);
  const [deleting, setDeleting] = useState<OrgDepartment | null>(null);
  const index = useMemo(
    () => (structure ? orgIndex(structure) : null),
    [structure],
  );
  const unassigned = useMemo(
    () =>
      structure ? peopleWithoutDepartment(everyone.people, structure) : [],
    [everyone.people, structure],
  );

  async function move(department: OrgDepartment, direction: "up" | "down") {
    try {
      await api.moveDepartment(department.id, direction);
    } catch (cause) {
      Alert.alert(orgErrorText(cause));
    } finally {
      void refresh();
    }
  }

  const moves =
    structure && menuFor
      ? departmentMoves(structure, menuFor.id)
      : { up: false, down: false };

  return (
    <SettingsScreen
      title={t("orgTitle")}
      subtitle={t("orgSettingsSubtitle")}
      allowed={org.canManage}
      query={org.available ? org.query : undefined}
      testID="settings-org-screen"
    >
      {structure && index ? (
        <>
          <SettingsGroup
            title={t("orgDepartmentsGroup")}
            hint={t("orgAdditionalHint")}
          >
            {index.order.length === 0 ? (
              <GroupBody>
                <Text tone="muted" size={14}>
                  {t("orgNoDepartmentsYet")}
                </Text>
              </GroupBody>
            ) : null}
            {index.order.map((department, position) => {
              const depth = index.depth.get(department.id) ?? 0;
              const lead = personName(everyone.byID, department.lead_actor_id);
              return (
                <View key={department.id}>
                  {position > 0 && <Divider />}
                  <View
                    style={[
                      styles.department,
                      { paddingLeft: 14 + depth * 18 },
                    ]}
                  >
                    <Pressable
                      testID={`org-settings-department-${position}`}
                      accessibilityRole="button"
                      onPress={() => setEditing({ id: department.id })}
                      style={({ pressed }) => [
                        styles.departmentBody,
                        pressed && { opacity: 0.6 },
                      ]}
                    >
                      <DepartmentIcon />
                      <View style={styles.grow}>
                        <Text size={15.5} numberOfLines={2}>
                          {department.name}
                        </Text>
                        <Text tone="muted" size={12.5} numberOfLines={1}>
                          {t("orgLeadCount", {
                            name: lead || t("orgNoLead"),
                            count: departmentCount(structure, department.id),
                          })}
                        </Text>
                      </View>
                    </Pressable>
                    <IconButton
                      testID={`org-settings-department-menu-${position}`}
                      label={`${t("orgDepartmentActions")}: ${department.name}`}
                      onPress={() => setMenuFor(department)}
                      icon={(color) => (
                        <MoreHorizontal size={20} color={color} />
                      )}
                    />
                  </View>
                </View>
              );
            })}
            <Divider />
            <ActionRow
              testID="org-settings-add-department"
              icon={Plus}
              label={t("orgAddDepartmentLabel")}
              onPress={() => setEditing({ id: null })}
            />
          </SettingsGroup>

          <SettingsGroup>
            <NavRow
              testID="org-settings-positions"
              icon={Briefcase}
              label={t("orgPositions")}
              value={String(structure.positions.length)}
              onPress={() =>
                router.push("/settings/workspace/org/positions" as never)
              }
            />
            <Divider />
            <NavRow
              testID="org-settings-unassigned"
              icon={UserRoundX}
              label={t("orgUnassigned")}
              value={everyone.loading ? "…" : String(unassigned.length)}
              onPress={() =>
                router.push("/settings/workspace/org/unassigned" as never)
              }
            />
          </SettingsGroup>

          <DepartmentEditor
            visible={editing !== null}
            departmentID={editing?.id ?? null}
            onClose={() => setEditing(null)}
          />
          <MenuSheet
            visible={menuFor !== null}
            title={menuFor?.name}
            testID="org-settings-department-menu"
            onClose={() => setMenuFor(null)}
            items={
              menuFor
                ? [
                    {
                      key: "edit",
                      label: t("orgEdit"),
                      icon: <Pencil size={20} color={theme.foreground} />,
                      testID: "org-menu-edit",
                      onPress: () => {
                        const id = menuFor.id;
                        setMenuFor(null);
                        afterSheetCloses(() => setEditing({ id }));
                      },
                    },
                    {
                      key: "up",
                      label: t("orgMoveUp"),
                      icon: <ArrowUp size={20} color={theme.foreground} />,
                      disabled: !moves.up,
                      testID: "org-menu-up",
                      onPress: () => {
                        const target = menuFor;
                        setMenuFor(null);
                        void move(target, "up");
                      },
                    },
                    {
                      key: "down",
                      label: t("orgMoveDown"),
                      icon: <ArrowDown size={20} color={theme.foreground} />,
                      disabled: !moves.down,
                      testID: "org-menu-down",
                      onPress: () => {
                        const target = menuFor;
                        setMenuFor(null);
                        void move(target, "down");
                      },
                    },
                    {
                      key: "delete",
                      label: t("orgDelete"),
                      icon: <Trash2 size={20} color={theme.danger} />,
                      danger: true,
                      testID: "org-menu-delete",
                      onPress: () => {
                        const target = menuFor;
                        setMenuFor(null);
                        afterSheetCloses(() => setDeleting(target));
                      },
                    },
                  ]
                : []
            }
          />
          {deleting ? (
            <DeleteDepartmentSheet
              visible
              department={deleting}
              onClose={() => setDeleting(null)}
              onDeleted={() => setDeleting(null)}
            />
          ) : null}
        </>
      ) : null}
    </SettingsScreen>
  );
}

/**
 * «Должности»: the list with how many people hold each, «+ Должность»,
 * rename and delete («У N человек должность снимется»), and «Должности из
 * подписей профилей».
 */
export function OrgPositionsScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const { api } = useSignedIn();
  const org = useOrg();
  const refresh = useOrgRefresh();
  const structure = org.structure;
  const [naming, setNaming] = useState<{ position: OrgPosition | null } | null>(
    null,
  );
  const [menuFor, setMenuFor] = useState<OrgPosition | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const positions = useMemo(
    () => (structure ? orgIndex(structure).positionOrder : []),
    [structure],
  );

  function remove(position: OrgPosition) {
    if (!structure) return;
    const count = positionPeople(structure, position.id).length;
    Alert.alert(
      t("orgDeletePosition", { name: position.name }),
      t("orgDeletePositionPeople", { count }),
      [
        { text: t("cancel"), style: "cancel" },
        {
          text: t("orgDelete"),
          style: "destructive",
          onPress: () =>
            void api
              .deletePosition(position.id)
              .catch((cause) => Alert.alert(orgErrorText(cause)))
              .finally(() => void refresh()),
        },
      ],
    );
  }

  return (
    <SettingsScreen
      title={t("orgPositions")}
      allowed={org.canManage}
      query={org.available ? org.query : undefined}
      testID="settings-org-positions"
    >
      {structure ? (
        <>
          <SettingsGroup>
            {positions.length === 0 ? (
              <GroupBody>
                <Text tone="muted" size={14}>
                  {t("orgPositionsEmpty")}
                </Text>
              </GroupBody>
            ) : null}
            {positions.map((position, index) => (
              <View key={position.id}>
                {index > 0 && <Divider />}
                <View style={styles.position}>
                  <Pressable
                    testID={`org-position-${index}`}
                    accessibilityRole="button"
                    accessibilityHint={t("orgRenamePosition")}
                    onPress={() => setNaming({ position })}
                    style={({ pressed }) => [
                      styles.positionBody,
                      pressed && { opacity: 0.6 },
                    ]}
                  >
                    <Text size={16} numberOfLines={2}>
                      {position.name}
                    </Text>
                    <Text tone="muted" size={13}>
                      {t("orgPositionPeople", {
                        count: positionPeople(structure, position.id).length,
                      })}
                    </Text>
                  </Pressable>
                  <IconButton
                    testID={`org-position-menu-${index}`}
                    label={`${t("orgPositionActions")}: ${position.name}`}
                    onPress={() => setMenuFor(position)}
                    icon={(color) => <MoreHorizontal size={20} color={color} />}
                  />
                </View>
              </View>
            ))}
            <Divider />
            <ActionRow
              testID="org-position-add"
              icon={Plus}
              label={t("orgAddPosition")}
              onPress={() => setNaming({ position: null })}
            />
          </SettingsGroup>
          <SettingsGroup hint={t("orgTitleSuggestionsHint")}>
            <NavRow
              testID="org-title-suggestions"
              label={t("orgTitleSuggestions")}
              onPress={() => setSuggesting(true)}
            />
          </SettingsGroup>

          <PositionNameSheet
            visible={naming !== null}
            position={naming?.position ?? null}
            onClose={() => setNaming(null)}
          />
          <TitleSuggestionsSheet
            visible={suggesting}
            onClose={() => setSuggesting(false)}
          />
          <MenuSheet
            visible={menuFor !== null}
            title={menuFor?.name}
            onClose={() => setMenuFor(null)}
            items={
              menuFor
                ? [
                    {
                      key: "rename",
                      label: t("orgRenamePosition"),
                      icon: <Pencil size={20} color={theme.foreground} />,
                      testID: "org-position-rename",
                      onPress: () => {
                        const position = menuFor;
                        setMenuFor(null);
                        afterSheetCloses(() => setNaming({ position }));
                      },
                    },
                    {
                      key: "delete",
                      label: t("orgDelete"),
                      icon: <Trash2 size={20} color={theme.danger} />,
                      danger: true,
                      testID: "org-position-delete",
                      onPress: () => {
                        const position = menuFor;
                        setMenuFor(null);
                        afterSheetCloses(() => remove(position));
                      },
                    },
                  ]
                : []
            }
          />
        </>
      ) : null}
    </SettingsScreen>
  );
}

/** A new position or a new name of one. */
function PositionNameSheet({
  visible,
  position,
  onClose,
}: {
  visible: boolean;
  position: OrgPosition | null;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { api } = useSignedIn();
  const refresh = useOrgRefresh();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (visible) {
      setName(position?.name ?? "");
      setError(undefined);
    }
  }, [position, visible]);

  async function save() {
    const value = name.trim();
    if (!value) {
      setError(t("orgNameRequired"));
      return;
    }
    setPending(true);
    try {
      if (position)
        await api.updatePosition(position.id, {
          name: value,
          expected_version: position.version,
        });
      else await api.createPosition(value);
      await refresh();
      onClose();
    } catch (cause) {
      setError(orgErrorText(cause));
      void refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <PageSheet
      visible={visible}
      title={position ? t("orgRenamePosition") : t("orgAddPosition")}
      onClose={onClose}
      testID="org-position-sheet"
      trailing={
        <HeaderAction
          testID="org-position-save"
          label={t("orgSave")}
          pending={pending}
          onPress={() => void save()}
        />
      }
    >
      <View style={[styles.sheet, { backgroundColor: theme.canvas }]}>
        <SettingsGroup>
          <GroupBody>
            <TextField
              testID="org-position-name"
              label={t("orgPositionName")}
              placeholder={t("orgPositionPlaceholder")}
              value={name}
              maxLength={60}
              autoFocus
              error={error}
              onChangeText={(value) => {
                setError(undefined);
                setName(value);
              }}
              onSubmitEditing={() => void save()}
              returnKeyType="done"
            />
          </GroupBody>
        </SettingsGroup>
      </View>
    </PageSheet>
  );
}

/**
 * «Должности из подписей профилей»: distinct profile titles with how many
 * carry each. The ticked ones become positions and go to those people.
 */
function TitleSuggestionsSheet({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { api } = useSignedIn();
  const refresh = useOrgRefresh();
  const suggestions = useQuery({
    queryKey: ["org", "title-suggestions"],
    queryFn: () => api.titleSuggestions(),
    enabled: visible,
    staleTime: 0,
  });
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (visible) setChosen(new Set());
  }, [visible]);

  async function create() {
    const picked = (suggestions.data ?? []).filter((item) =>
      chosen.has(item.title),
    );
    if (!picked.length) return;
    setPending(true);
    try {
      const result = await api.createPositions(
        picked.map((item) => item.title),
      );
      const byName = new Map(
        result.created.map((position) => [
          position.name.trim().toLocaleLowerCase(),
          position.id,
        ]),
      );
      for (const item of picked) {
        const id = byName.get(item.title.trim().toLocaleLowerCase());
        if (id && item.actor_ids.length)
          await api.assignPeopleOrg({
            actor_ids: item.actor_ids.slice(0, 200),
            position_id: id,
          });
      }
      await refresh();
      Alert.alert(t("orgPositionsCreated", { count: result.created.length }));
      onClose();
    } catch (cause) {
      Alert.alert(orgErrorText(cause));
      void refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <PageSheet
      visible={visible}
      title={t("orgTitleSuggestions")}
      onClose={onClose}
      testID="org-title-suggestions-sheet"
      trailing={
        <HeaderAction
          testID="org-title-suggestions-create"
          label={t("orgCreatePositions", { count: chosen.size })}
          disabled={chosen.size === 0}
          pending={pending}
          onPress={() => void create()}
        />
      }
    >
      {suggestions.isPending ? (
        <ActivityIndicator style={styles.loader} color={theme.muted} />
      ) : suggestions.isError ? (
        <View style={styles.sheet}>
          <Notice
            title={orgErrorText(suggestions.error)}
            actionLabel={t("retry")}
            onAction={() => void suggestions.refetch()}
          />
        </View>
      ) : (
        <FlatList
          data={suggestions.data}
          keyExtractor={(item) => item.title}
          ListHeaderComponent={
            <Text tone="muted" size={13.5} style={styles.hint}>
              {suggestions.data?.length
                ? t("orgTitleSuggestionsHint")
                : t("orgTitleSuggestionsEmpty")}
            </Text>
          }
          renderItem={({ item, index }) => {
            const on = chosen.has(item.title);
            return (
              <Pressable
                testID={`org-title-suggestion-${index}`}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                onPress={() =>
                  setChosen((current) => {
                    const next = new Set(current);
                    if (next.has(item.title)) next.delete(item.title);
                    else next.add(item.title);
                    return next;
                  })
                }
                style={({ pressed }) => [
                  styles.suggestion,
                  pressed && { backgroundColor: theme.surfaceSelected },
                ]}
              >
                <View style={styles.grow}>
                  <Text size={15.5}>{item.title}</Text>
                  <Text tone="muted" size={13}>
                    {t("orgTitleSuggestionPeople", { count: item.count })}
                  </Text>
                </View>
                <View
                  style={[
                    styles.check,
                    on
                      ? {
                          backgroundColor: theme.primary,
                          borderColor: theme.primary,
                        }
                      : { borderColor: theme.borderStrong },
                  ]}
                >
                  {on ? (
                    <Check
                      size={14}
                      strokeWidth={2.6}
                      color={theme.onPrimary}
                    />
                  ) : null}
                </View>
              </Pressable>
            );
          }}
        />
      )}
    </PageSheet>
  );
}

/**
 * «Без отдела · N»: people without a primary department. Ticked people get
 * a department or a position at once (assignPeopleOrg).
 */
export function OrgUnassignedScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const { api } = useSignedIn();
  const org = useOrg();
  const refresh = useOrgRefresh();
  const everyone = useAllPeople();
  const structure = org.structure;
  const people = useMemo(
    () =>
      structure
        ? peopleWithoutDepartment(everyone.people, structure).sort(
            (left, right) =>
              left.display_name.localeCompare(right.display_name),
          )
        : [],
    [everyone.people, structure],
  );
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [picking, setPicking] = useState<"department" | "position" | null>(
    null,
  );
  const [pending, setPending] = useState(false);
  const selected = people.filter((person) => chosen.has(person.actor_id));

  async function assign(input: {
    primary_department_id?: string;
    position_id?: string | null;
  }) {
    if (!selected.length) return;
    setPending(true);
    try {
      const ids = selected.map((person) => person.actor_id);
      for (let start = 0; start < ids.length; start += 200)
        await api.assignPeopleOrg({
          actor_ids: ids.slice(start, start + 200),
          ...input,
        });
      await refresh();
      Alert.alert(t("orgAssigned", { count: ids.length }));
      setChosen(new Set());
    } catch (cause) {
      Alert.alert(orgErrorText(cause));
      void refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <SettingsScreen
      title={t("orgUnassigned")}
      subtitle={
        chosen.size ? t("orgSelected", { count: chosen.size }) : undefined
      }
      allowed={org.canManage}
      query={org.available ? org.query : undefined}
      scroll={false}
      testID="settings-org-unassigned"
      trailing={
        people.length ? (
          <HeaderAction
            testID="org-unassigned-select-all"
            label={
              chosen.size === people.length
                ? t("orgClearSelection")
                : t("orgSelectAll")
            }
            onPress={() =>
              setChosen(
                chosen.size === people.length
                  ? new Set()
                  : new Set(people.map((person) => person.actor_id)),
              )
            }
          />
        ) : undefined
      }
    >
      {structure ? (
        <>
          <FlatList
            data={people}
            keyExtractor={(person) => person.actor_id}
            style={{ backgroundColor: theme.surface }}
            ListHeaderComponent={
              people.length ? (
                <Text tone="muted" size={13.5} style={styles.hint}>
                  {t("orgUnassignedHint")}
                </Text>
              ) : null
            }
            ListEmptyComponent={
              everyone.loading ? (
                <ActivityIndicator style={styles.loader} color={theme.muted} />
              ) : (
                <Text tone="muted" size={15} style={styles.empty}>
                  {t("orgUnassignedEmpty")}
                </Text>
              )
            }
            renderItem={({ item, index }) => (
              <PersonRow
                testID={`org-unassigned-${index}`}
                person={item}
                meta={personOrgLine(item, structure)}
                selected={chosen.has(item.actor_id)}
                onPress={() =>
                  setChosen((current) => {
                    const next = new Set(current);
                    if (next.has(item.actor_id)) next.delete(item.actor_id);
                    else next.add(item.actor_id);
                    return next;
                  })
                }
              />
            )}
          />
          {chosen.size > 0 ? (
            <View
              style={[
                styles.bar,
                {
                  backgroundColor: theme.surface,
                  borderTopColor: theme.border,
                },
              ]}
            >
              <View style={styles.grow}>
                <Button
                  testID="org-unassigned-department"
                  label={t("orgAssignDepartment")}
                  pending={pending}
                  disabled={!structure.departments.length}
                  onPress={() => setPicking("department")}
                />
              </View>
              <View style={styles.grow}>
                <Button
                  testID="org-unassigned-position"
                  variant="secondary"
                  label={t("orgAssignPosition")}
                  disabled={pending || !structure.positions.length}
                  onPress={() => setPicking("position")}
                />
              </View>
            </View>
          ) : null}
          <DepartmentPickerSheet
            visible={picking === "department"}
            title={t("orgAssignDepartment")}
            structure={structure}
            selected={[]}
            testID="org-assign-department"
            onClose={() => setPicking(null)}
            onPick={([id]) =>
              id ? void assign({ primary_department_id: id }) : undefined
            }
          />
          <PositionPickerSheet
            visible={picking === "position"}
            structure={structure}
            selected={null}
            testID="org-assign-position"
            onClose={() => setPicking(null)}
            onPick={(id) => void assign({ position_id: id })}
          />
        </>
      ) : null}
    </SettingsScreen>
  );
}

const styles = StyleSheet.create({
  department: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingRight: spacing[2],
    minHeight: 56,
  },
  departmentBody: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 8,
  },
  grow: { flex: 1, minWidth: 0 },
  position: {
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: spacing[4],
    paddingRight: spacing[2],
    minHeight: 56,
  },
  positionBody: { flex: 1, paddingVertical: 8 },
  sheet: { flex: 1, padding: spacing[4] },
  loader: { marginTop: spacing[8] },
  hint: { padding: spacing[4] },
  empty: { padding: spacing[5], textAlign: "center" },
  suggestion: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: spacing[4],
    paddingVertical: 8,
    minHeight: 56,
  },
  check: {
    width: 22,
    height: 22,
    borderRadius: 7,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  bar: {
    flexDirection: "row",
    gap: spacing[2],
    padding: spacing[3],
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
