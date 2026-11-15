import { useState } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { departmentPath, personOrg } from "@comamessenger/core";
import { Divider, NavRow, SettingsGroup } from "@/ui/Settings";
import { PersonOrgEditor } from "./PersonOrgEditor";
import { useOrg } from "./useOrg";

/**
 * «Участники → человек → Оргструктура»: the primary department, the
 * additional ones and the position; any row opens the editor.
 */
export function MemberOrgGroup({
  actorID,
  name,
}: {
  actorID: string;
  name: string;
}) {
  const { t } = useTranslation();
  const { structure } = useOrg();
  const [editing, setEditing] = useState(false);
  if (!structure) return null;
  const org = personOrg(structure, actorID);
  const rows = [
    {
      key: "primary",
      label: t("orgMemberPrimary"),
      value: org.primary
        ? departmentPath(structure, org.primary.id)
        : t("orgNoDepartment"),
    },
    {
      key: "additional",
      label: t("orgMemberAdditional"),
      value: org.additional.length
        ? org.additional.map((department) => department.name).join(", ")
        : t("orgNone"),
    },
    {
      key: "position",
      label: t("orgMemberPosition"),
      value: org.position?.name ?? t("orgNoPosition"),
    },
  ];
  return (
    <>
      <SettingsGroup title={t("orgMemberGroup")} hint={t("orgAdditionalHint")}>
        {rows.map((row, index) => (
          <View key={row.key}>
            {index > 0 && <Divider />}
            <NavRow
              testID={`member-org-${row.key}`}
              label={row.label}
              value={row.value}
              onPress={() => setEditing(true)}
            />
          </View>
        ))}
      </SettingsGroup>
      <PersonOrgEditor
        visible={editing}
        actorID={actorID}
        name={name}
        onClose={() => setEditing(false)}
      />
    </>
  );
}
