import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { Briefcase } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  departmentPath,
  managerOf,
  personOrg,
  personOrgLine,
  subordinatesOf,
  type OrgStructure,
} from "@comamessenger/core";
import { radius } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { PersonRow } from "@/people/PersonRow";
import { Avatar } from "@/ui/Avatar";
import { Text } from "@/ui/Text";
import { DepartmentIcon, KVRow, OrgTag } from "./parts";
import { useAllPeople } from "./useOrg";

const subordinatesShown = 4;

/**
 * Whether the caption of a profile (`title`) says more than the position:
 * shown under the name unless it repeats the position (decision 3).
 */
export function showsOwnTitle(
  title: string | null | undefined,
  structure: OrgStructure | null,
  actorID: string,
): boolean {
  const text = title?.trim();
  if (!text) return false;
  const position = structure ? personOrg(structure, actorID).position : null;
  return (
    !position ||
    position.name.trim().toLocaleLowerCase() !== text.toLocaleLowerCase()
  );
}

/**
 * The org part of a person card (tab C): the position; the primary
 * department with its path and the additional ones («совм.») as links;
 * the manager as a link; «Подчинённые · N» (first four, then «Все»).
 */
export function PersonOrgSection({
  structure,
  actorID,
}: {
  structure: OrgStructure;
  actorID: string;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const everyone = useAllPeople();
  const [all, setAll] = useState(false);
  const org = personOrg(structure, actorID);
  const managerID = managerOf(structure, actorID);
  const manager = managerID ? everyone.byID.get(managerID) : undefined;
  const subordinates = subordinatesOf(structure, actorID)
    .map((id) => everyone.byID.get(id))
    .filter((person) => person !== undefined);
  const rows = Boolean(
    org.position || org.primary || org.additional.length || managerID,
  );
  const card = [
    styles.card,
    { backgroundColor: theme.surface, borderColor: theme.border },
  ];

  return (
    <>
      {rows ? (
        <View style={card} testID="person-org">
          {org.position ? (
            <KVRow
              first
              testID="person-position"
              leading={
                <View
                  style={[
                    styles.icon,
                    { backgroundColor: theme.surfaceSelected },
                  ]}
                >
                  <Briefcase size={16} color={theme.muted} />
                </View>
              }
              title={org.position.name}
              caption={t("orgPositionCaption")}
            />
          ) : null}
          {org.primary
            ? (() => {
                const path = departmentPath(structure, org.primary.id, {
                  includeSelf: false,
                });
                const id = org.primary.id;
                return (
                  <KVRow
                    first={!org.position}
                    testID="person-department"
                    leading={<DepartmentIcon />}
                    title={org.primary.name}
                    caption={
                      path
                        ? t("orgDepartmentPathCaption", { path })
                        : t("orgDepartmentCaption")
                    }
                    hint={t("orgOpenDepartmentHint")}
                    onPress={() => router.push(`/org/${id}` as never)}
                  />
                );
              })()
            : null}
          {org.additional.map((department, index) => {
            const path = departmentPath(structure, department.id, {
              includeSelf: false,
            });
            return (
              <KVRow
                key={department.id}
                testID={`person-additional-${index}`}
                leading={<DepartmentIcon />}
                title={
                  <View style={styles.titleLine}>
                    <Text size={15} numberOfLines={2} style={styles.shrink}>
                      {department.name}
                    </Text>
                    <OrgTag kind="additional" />
                  </View>
                }
                caption={path || undefined}
                hint={t("orgOpenDepartmentHint")}
                onPress={() => router.push(`/org/${department.id}` as never)}
              />
            );
          })}
          {managerID ? (
            <KVRow
              testID="person-manager"
              leading={
                <Avatar
                  name={manager?.display_name ?? ""}
                  seed={managerID}
                  actorID={managerID}
                  avatarVersion={manager?.avatar_version}
                  size={30}
                />
              }
              title={manager?.display_name ?? "…"}
              caption={t("orgLeadCaption")}
              hint={t("openProfileHint")}
              onPress={() => router.push(`/people/${managerID}`)}
            />
          ) : null}
        </View>
      ) : null}
      {subordinates.length ? (
        <View style={card} testID="person-subordinates">
          <View style={styles.heading}>
            <Text tone="muted" size={13} weight="semibold" style={styles.grow}>
              {t("orgSubordinates", { count: subordinates.length })}
            </Text>
            {subordinates.length > subordinatesShown ? (
              <Text
                testID="person-subordinates-all"
                accessibilityRole="button"
                tone="primary"
                size={13}
                weight="semibold"
                onPress={() => setAll(!all)}
              >
                {all ? t("orgShowLess") : t("orgShowAll")}
              </Text>
            ) : null}
          </View>
          {(all ? subordinates : subordinates.slice(0, subordinatesShown)).map(
            (person, index) => (
              <PersonRow
                key={person.actor_id}
                testID={`person-subordinate-${index}`}
                person={person}
                meta={personOrgLine(person, structure)}
                hint={t("openProfileHint")}
                onPress={() => router.push(`/people/${person.actor_id}`)}
              />
            ),
          )}
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.xl,
    borderWidth: 1,
    overflow: "hidden",
  },
  icon: {
    width: 30,
    height: 30,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  titleLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  shrink: { flexShrink: 1 },
  heading: {
    flexDirection: "row",
    alignItems: "center",
    paddingTop: 11,
    paddingHorizontal: 14,
    paddingBottom: 4,
  },
  grow: { flex: 1 },
});
