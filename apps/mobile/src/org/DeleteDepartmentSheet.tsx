import { useEffect, useMemo, useState } from "react";
import { Alert, ScrollView, StyleSheet, View } from "react-native";
import { Trash2 } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  departmentDeletionTargets,
  departmentPath,
  orgIndex,
  type OrgDepartment,
} from "@comamessenger/core";
import { spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { useSignedIn } from "@/session/SessionProvider";
import { PageSheet } from "@/ui/PageSheet";
import { ActionRow, ChoiceRow, Divider, SettingsGroup } from "@/ui/Settings";
import { Text } from "@/ui/Text";
import { orgErrorText } from "./parts";
import { useOrg, useOrgRefresh } from "./useOrg";

/**
 * «Удалить» with the choice where the primary members go (decision 12):
 * the parent by default, any other department or «Без отдела».
 * Subdepartments move to the parent; the chat stays.
 */
export function DeleteDepartmentSheet({
  visible,
  department,
  onClose,
  onDeleted,
}: {
  visible: boolean;
  department: OrgDepartment;
  onClose(): void;
  onDeleted(): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { api } = useSignedIn();
  const { structure } = useOrg();
  const refresh = useOrgRefresh();
  const targets = useMemo(
    () =>
      structure
        ? departmentDeletionTargets(structure, department.id)
        : { options: [], defaultTarget: "none" as const },
    [department.id, structure],
  );
  const [target, setTarget] = useState<string>(targets.defaultTarget);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (visible) setTarget(targets.defaultTarget);
  }, [targets.defaultTarget, visible]);
  if (!structure) return null;
  const primaryCount = (
    orgIndex(structure).members.get(department.id) ?? []
  ).filter((membership) => membership.primary).length;

  async function remove() {
    setPending(true);
    try {
      await api.deleteDepartment(department.id, target);
      await refresh();
      onDeleted();
    } catch (cause) {
      Alert.alert(orgErrorText(cause));
      void refresh();
    } finally {
      setPending(false);
    }
  }

  const label = (id: string, name: string) =>
    id === targets.defaultTarget ? t("orgDeleteDefault", { name }) : name;

  return (
    <PageSheet
      visible={visible}
      title={t("orgDeleteTitle", { name: department.name })}
      onClose={onClose}
      testID="department-delete"
    >
      <ScrollView
        contentContainerStyle={styles.content}
        style={{ backgroundColor: theme.canvas }}
      >
        <Text tone="muted" size={14}>
          {t("orgDeleteHint")}
        </Text>
        <Text weight="semibold" size={15}>
          {t("orgDeletePeople", { count: primaryCount })}
        </Text>
        {primaryCount > 0 ? (
          <SettingsGroup title={t("orgDeleteMoveTo")}>
            <ChoiceRow
              testID="department-delete-target-none"
              label={label("none", t("orgDeleteNone"))}
              selected={target === "none"}
              onPress={() => setTarget("none")}
            />
            {targets.options.map((option, position) => (
              <View key={option.id}>
                <Divider />
                <ChoiceRow
                  testID={`department-delete-target-${position}`}
                  label={label(option.id, departmentPath(structure, option.id))}
                  selected={target === option.id}
                  onPress={() => setTarget(option.id)}
                />
              </View>
            ))}
          </SettingsGroup>
        ) : null}
        <SettingsGroup>
          <ActionRow
            testID="department-delete-confirm"
            icon={Trash2}
            tone="danger"
            label={t("orgDeleteConfirm")}
            pending={pending}
            onPress={() => void remove()}
          />
        </SettingsGroup>
      </ScrollView>
    </PageSheet>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing[4], gap: spacing[4], paddingBottom: spacing[8] },
});
