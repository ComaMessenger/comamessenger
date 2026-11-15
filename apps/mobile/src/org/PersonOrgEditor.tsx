import { useEffect, useState } from "react";
import { Alert, ScrollView, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import { orgIndex, personOrg } from "@comamessenger/core";
import { spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { useSignedIn } from "@/session/SessionProvider";
import { HeaderAction } from "@/knowledge/HeaderAction";
import { PageSheet } from "@/ui/PageSheet";
import { Divider, NavRow, SettingsGroup } from "@/ui/Settings";
import { orgErrorText } from "./parts";
import { DepartmentPickerSheet, PositionPickerSheet } from "./pickers";
import { useOrg, useOrgRefresh } from "./useOrg";

type Draft = {
  primary: string | null;
  additional: string[];
  position: string | null;
};

/** At most this many additional departments (409 org_limit_reached). */
const additionalLimit = 10;

/**
 * «Изменить отдел и должность» of one person: the primary department, the
 * additional ones (совместитель) and the position, saved at once
 * (setPersonOrg). Opened from the person card and from «Участники».
 */
export function PersonOrgEditor({
  visible,
  actorID,
  name,
  onClose,
}: {
  visible: boolean;
  actorID: string;
  name: string;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { api } = useSignedIn();
  const { structure } = useOrg();
  const refresh = useOrgRefresh();
  const [draft, setDraft] = useState<Draft>({
    primary: null,
    additional: [],
    position: null,
  });
  const [picking, setPicking] = useState<
    "primary" | "additional" | "position" | null
  >(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!visible || !structure) return;
    const org = personOrg(structure, actorID);
    setDraft({
      primary: org.primary?.id ?? null,
      additional: org.additional.map((department) => department.id),
      position: org.position?.id ?? null,
    });
    // Taken when the sheet opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, actorID]);

  if (!structure) return null;
  const index = orgIndex(structure);
  const nameOf = (id: string | null) =>
    (id && index.departments.get(id)?.name) || t("orgNone");

  async function save() {
    if (!structure) return;
    setPending(true);
    try {
      await api.setPersonOrg(actorID, {
        primary_department_id: draft.primary,
        additional_department_ids: draft.primary
          ? draft.additional.filter((id) => id !== draft.primary)
          : [],
        position_id: draft.position,
        expected_org_version: structure.version,
      });
      await refresh();
      onClose();
    } catch (cause) {
      await refresh();
      Alert.alert(orgErrorText(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <PageSheet
      visible={visible}
      title={t("orgPersonEditorTitle")}
      subtitle={name}
      onClose={onClose}
      testID="person-org-editor"
      trailing={
        <HeaderAction
          testID="person-org-save"
          label={t("orgSave")}
          pending={pending}
          onPress={() => void save()}
        />
      }
    >
      <ScrollView
        contentContainerStyle={styles.content}
        style={{ backgroundColor: theme.canvas }}
      >
        <SettingsGroup hint={t("orgAdditionalHint")}>
          <NavRow
            testID="person-org-primary"
            label={t("orgMemberPrimary")}
            value={draft.primary ? nameOf(draft.primary) : t("orgNoDepartment")}
            onPress={() => setPicking("primary")}
          />
          <Divider />
          <NavRow
            testID="person-org-additional"
            label={t("orgMemberAdditional")}
            value={
              draft.additional.length
                ? draft.additional.map(nameOf).join(", ")
                : t("orgNone")
            }
            disabled={!draft.primary}
            onPress={() => setPicking("additional")}
          />
          <Divider />
          <NavRow
            testID="person-org-position"
            label={t("orgMemberPosition")}
            value={
              (draft.position && index.positions.get(draft.position)?.name) ||
              t("orgNoPosition")
            }
            onPress={() => setPicking("position")}
          />
        </SettingsGroup>
      </ScrollView>
      <DepartmentPickerSheet
        visible={picking === "primary"}
        title={t("orgMemberPrimary")}
        structure={structure}
        selected={[draft.primary]}
        none={t("orgNoDepartment")}
        testID="person-org-primary-picker"
        onClose={() => setPicking(null)}
        onPick={([id]) =>
          setDraft({
            ...draft,
            primary: id ?? null,
            additional: id
              ? draft.additional.filter((item) => item !== id)
              : [],
          })
        }
      />
      <DepartmentPickerSheet
        visible={picking === "additional"}
        title={t("orgMemberAdditional")}
        structure={structure}
        options={index.order.filter((item) => item.id !== draft.primary)}
        selected={draft.additional}
        multiple
        max={additionalLimit}
        testID="person-org-additional-picker"
        onClose={() => setPicking(null)}
        onPick={(ids) =>
          setDraft({
            ...draft,
            additional: ids.filter((id): id is string => Boolean(id)),
          })
        }
      />
      <PositionPickerSheet
        visible={picking === "position"}
        structure={structure}
        selected={draft.position}
        testID="person-org-position-picker"
        onClose={() => setPicking(null)}
        onPick={(position) => setDraft({ ...draft, position })}
      />
    </PageSheet>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing[4], gap: spacing[4] },
});
