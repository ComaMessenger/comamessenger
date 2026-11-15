import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  View,
} from "react-native";
import { ArrowDown, ArrowUp, Plus, Trash2, X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  departmentMoves,
  departmentParentOptions,
  orgIndex,
  personOrg,
  type OrgStructure,
} from "@comamessenger/core";
import { spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { useSignedIn } from "@/session/SessionProvider";
import { HeaderAction } from "@/knowledge/HeaderAction";
import { Avatar } from "@/ui/Avatar";
import { PageSheet } from "@/ui/PageSheet";
import {
  ActionRow,
  ChoiceRow,
  Divider,
  GroupBody,
  NavRow,
  SettingsGroup,
} from "@/ui/Settings";
import { Text } from "@/ui/Text";
import { TextField } from "@/ui/TextField";
import { DeleteDepartmentSheet } from "./DeleteDepartmentSheet";
import { orgErrorText } from "./parts";
import { DepartmentPickerSheet, PersonPickerSheet } from "./pickers";
import { personName, useAllPeople, useOrg, useOrgRefresh } from "./useOrg";

type Draft = {
  name: string;
  parentID: string | null;
  /** actor id → is this their primary department. */
  members: Map<string, boolean>;
  leadID: string | null;
};

function draftOf(
  structure: OrgStructure | null,
  departmentID: string | null,
  parentID: string | null,
): Draft {
  if (!structure || !departmentID)
    return { name: "", parentID, members: new Map(), leadID: null };
  const index = orgIndex(structure);
  const department = index.departments.get(departmentID);
  return {
    name: department?.name ?? "",
    parentID: department?.parent_id ?? null,
    members: new Map(
      (index.members.get(departmentID) ?? []).map((membership) => [
        membership.actorID,
        membership.primary,
      ]),
    ),
    leadID: department?.lead_actor_id ?? null,
  };
}

/**
 * Creating or editing a department (the sheet of tab E): the name, «Входит
 * в» (any department but its own subtree), the members with a «primary»
 * switch each and the current primary department under the name, the lead
 * among the members. Editing adds «Выше», «Ниже» and «Удалить».
 */
export function DepartmentEditor({
  visible,
  departmentID,
  parentID = null,
  onClose,
  onDeleted,
}: {
  visible: boolean;
  /** null creates a department. */
  departmentID: string | null;
  /** «Входит в» of a new department. */
  parentID?: string | null;
  onClose(): void;
  onDeleted?(): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { api } = useSignedIn();
  const org = useOrg();
  const refresh = useOrgRefresh();
  const everyone = useAllPeople();
  const structure = org.structure;
  const [draft, setDraft] = useState<Draft>(() =>
    draftOf(structure, departmentID, parentID),
  );
  const [initial, setInitial] = useState<Draft>(draft);
  const [picking, setPicking] = useState<"parent" | "people" | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [nameError, setNameError] = useState<string | undefined>();

  useEffect(() => {
    if (!visible) return;
    const next = draftOf(structure, departmentID, parentID);
    setDraft(next);
    setInitial(next);
    setNameError(undefined);
    // The draft is taken when the sheet opens; later org.updated events
    // do not overwrite what is being typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, departmentID]);

  const index = useMemo(
    () => (structure ? orgIndex(structure) : null),
    [structure],
  );
  const department = departmentID
    ? (index?.departments.get(departmentID) ?? null)
    : null;
  const parentOptions = useMemo(
    () =>
      structure
        ? departmentID
          ? departmentParentOptions(structure, departmentID)
          : (index?.order ?? [])
        : [],
    [departmentID, index, structure],
  );
  const moves =
    structure && departmentID
      ? departmentMoves(structure, departmentID)
      : { up: false, down: false };
  const memberIDs = [...draft.members.keys()].sort((left, right) =>
    personName(everyone.byID, left).localeCompare(
      personName(everyone.byID, right),
    ),
  );

  if (!structure) return null;

  function setMembers(ids: string[]) {
    setDraft((current) => {
      const members = new Map<string, boolean>();
      for (const id of ids)
        members.set(
          id,
          current.members.get(id) ??
            // A newcomer without a department gets it as the primary one.
            !personOrg(structure!, id).primary,
        );
      return {
        ...current,
        members,
        leadID:
          current.leadID && members.has(current.leadID) ? current.leadID : null,
      };
    });
  }

  async function save() {
    const name = draft.name.trim();
    if (!name) {
      setNameError(t("orgNameRequired"));
      return;
    }
    setSaving(true);
    try {
      if (!department) {
        await api.createDepartment({
          name,
          ...(draft.parentID ? { parent_id: draft.parentID } : {}),
          ...(draft.leadID ? { lead_actor_id: draft.leadID } : {}),
          members: [...draft.members].map(([actor_id, primary]) => ({
            actor_id,
            primary,
          })),
        });
      } else {
        // Name, place and lead first: a new lead joins as an additional
        // member on the server, the switches below then set the kind.
        const changed =
          name !== initial.name ||
          draft.parentID !== initial.parentID ||
          draft.leadID !== initial.leadID;
        if (changed)
          await api.updateDepartment(department.id, {
            ...(name !== initial.name ? { name } : {}),
            ...(draft.parentID !== initial.parentID
              ? { parent_id: draft.parentID }
              : {}),
            ...(draft.leadID !== initial.leadID
              ? { lead_actor_id: draft.leadID }
              : {}),
            expected_version: department.version,
          });
        for (const id of initial.members.keys())
          if (!draft.members.has(id))
            await api.removeDepartmentMember(department.id, id);
        for (const [id, primary] of draft.members)
          if (initial.members.get(id) !== primary || !initial.members.has(id))
            await api.setDepartmentMember(department.id, id, {
              primary,
              keep_previous: false,
            });
      }
      await refresh();
      onClose();
    } catch (cause) {
      await refresh();
      Alert.alert(orgErrorText(cause));
    } finally {
      setSaving(false);
    }
  }

  async function move(direction: "up" | "down") {
    if (!department) return;
    try {
      await api.moveDepartment(department.id, direction);
    } catch (cause) {
      Alert.alert(orgErrorText(cause));
    } finally {
      void refresh();
    }
  }

  const parentName = draft.parentID
    ? (index?.departments.get(draft.parentID)?.name ?? "")
    : t("orgTopLevelChoice");

  return (
    <PageSheet
      visible={visible}
      title={department ? department.name : t("orgNewDepartment")}
      onClose={onClose}
      testID="department-editor"
      trailing={
        <HeaderAction
          testID="department-editor-save"
          label={department ? t("orgSave") : t("orgCreateDepartment")}
          pending={saving}
          onPress={() => void save()}
        />
      }
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.content}
        style={{ backgroundColor: theme.canvas }}
      >
        <SettingsGroup>
          <GroupBody>
            <TextField
              testID="department-editor-name"
              label={t("orgName")}
              placeholder={t("orgNamePlaceholder")}
              value={draft.name}
              maxLength={60}
              error={nameError}
              onChangeText={(name) => {
                setNameError(undefined);
                setDraft({ ...draft, name });
              }}
            />
          </GroupBody>
          <Divider />
          <NavRow
            testID="department-editor-parent"
            label={t("orgParent")}
            value={parentName}
            onPress={() => setPicking("parent")}
          />
        </SettingsGroup>

        <SettingsGroup title={t("orgEmployeesTitle")}>
          {memberIDs.map((id, position) => {
            const person = everyone.byID.get(id);
            const primary = draft.members.get(id) ?? false;
            const current = personOrg(structure, id).primary;
            const elsewhere =
              current && current.id !== departmentID ? current : null;
            const caption = primary
              ? elsewhere
                ? `${t("orgCurrentPrimary", { name: elsewhere.name })} · ${t("orgMovesHere")}`
                : undefined
              : elsewhere
                ? t("orgKeepsPrimary", { name: elsewhere.name })
                : undefined;
            const name = person?.display_name ?? "";
            return (
              <View key={id}>
                {position > 0 && <Divider />}
                <View style={styles.member}>
                  <Avatar
                    name={name}
                    seed={id}
                    actorID={id}
                    avatarVersion={person?.avatar_version}
                    size={36}
                  />
                  <View style={styles.grow}>
                    <Text size={15.5} numberOfLines={1}>
                      {name}
                    </Text>
                    <Text tone="muted" size={12.5} numberOfLines={2}>
                      {caption ?? t("orgPrimarySwitch")}
                    </Text>
                  </View>
                  <Switch
                    testID={`department-editor-primary-${position}`}
                    accessibilityLabel={`${t("orgPrimarySwitch")}: ${name}`}
                    value={primary}
                    onValueChange={(value) =>
                      setDraft((currentDraft) => {
                        const members = new Map(currentDraft.members);
                        members.set(id, value);
                        return { ...currentDraft, members };
                      })
                    }
                    trackColor={{
                      true: theme.primary,
                      false: theme.borderStrong,
                    }}
                  />
                  <Pressable
                    testID={`department-editor-remove-${position}`}
                    accessibilityRole="button"
                    accessibilityLabel={`${t("orgRemoveFromDepartment")}: ${name}`}
                    hitSlop={8}
                    onPress={() =>
                      setMembers(memberIDs.filter((item) => item !== id))
                    }
                    style={styles.remove}
                  >
                    <X size={18} color={theme.muted} />
                  </Pressable>
                </View>
              </View>
            );
          })}
          {memberIDs.length > 0 && <Divider />}
          <ActionRow
            testID="department-editor-add-people"
            icon={Plus}
            label={t("orgAddEmployees")}
            onPress={() => setPicking("people")}
          />
        </SettingsGroup>

        <SettingsGroup
          title={t("orgLeadTitle")}
          hint={memberIDs.length ? undefined : t("orgLeadNeedsPeople")}
        >
          <ChoiceRow
            testID="department-editor-lead-none"
            label={t("orgNoLeadChoice")}
            selected={draft.leadID === null}
            onPress={() => setDraft({ ...draft, leadID: null })}
          />
          {memberIDs.map((id, position) => (
            <View key={id}>
              <Divider />
              <ChoiceRow
                testID={`department-editor-lead-${position}`}
                label={personName(everyone.byID, id)}
                selected={draft.leadID === id}
                onPress={() => setDraft({ ...draft, leadID: id })}
              />
            </View>
          ))}
        </SettingsGroup>

        {department ? (
          <SettingsGroup>
            <ActionRow
              testID="department-editor-up"
              icon={ArrowUp}
              tone="default"
              label={t("orgMoveUp")}
              disabled={!moves.up}
              onPress={() => void move("up")}
            />
            <Divider />
            <ActionRow
              testID="department-editor-down"
              icon={ArrowDown}
              tone="default"
              label={t("orgMoveDown")}
              disabled={!moves.down}
              onPress={() => void move("down")}
            />
            <Divider />
            <ActionRow
              testID="department-editor-delete"
              icon={Trash2}
              tone="danger"
              label={t("orgDelete")}
              onPress={() => setDeleting(true)}
            />
          </SettingsGroup>
        ) : null}
      </ScrollView>

      <DepartmentPickerSheet
        visible={picking === "parent"}
        title={t("orgParent")}
        structure={structure}
        options={parentOptions}
        selected={[draft.parentID]}
        none={t("orgTopLevelChoice")}
        testID="department-parent-picker"
        onClose={() => setPicking(null)}
        onPick={([id]) => setDraft({ ...draft, parentID: id ?? null })}
      />
      <PersonPickerSheet
        visible={picking === "people"}
        title={t("orgPickPeopleTitle")}
        people={everyone.people}
        structure={structure}
        selected={memberIDs}
        testID="department-people-picker"
        onClose={() => setPicking(null)}
        onPick={setMembers}
      />
      {department ? (
        <DeleteDepartmentSheet
          visible={deleting}
          department={department}
          onClose={() => setDeleting(false)}
          onDeleted={() => {
            setDeleting(false);
            onClose();
            onDeleted?.();
          }}
        />
      ) : null}
    </PageSheet>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing[4], gap: spacing[4], paddingBottom: spacing[8] },
  member: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingLeft: spacing[4],
    paddingRight: spacing[2],
    paddingVertical: 8,
    minHeight: 56,
  },
  grow: { flex: 1, minWidth: 0 },
  remove: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
});
