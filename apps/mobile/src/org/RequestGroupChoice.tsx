import { useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Check } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  departmentPath,
  expandDepartment,
  expandPosition,
  orgIndex,
  type ChatMember,
  type OrgStructure,
  type RequestDraftAudience,
} from "@comamessenger/core";
import { radius } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { Text } from "@/ui/Text";
import { DepartmentIcon } from "./parts";

/**
 * «Отдел» and «Должность» of the request form (wave 2, the «Запрос» tab of
 * the prototype): a list with a round check. A department shows its path
 * and how many of its people (with subdepartments) are in this chat; a
 * position — how many people holding it are here. Only people of the chat
 * count, the author never: the server expands the same way.
 */
export function RequestGroupChoice({
  kind,
  audience,
  structure,
  members,
  authorID,
  onChange,
}: {
  kind: "department" | "position";
  audience: RequestDraftAudience;
  structure: OrgStructure;
  members: readonly Pick<ChatMember, "actor_id" | "type">[];
  authorID: string;
  onChange(audience: RequestDraftAudience): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const rows = useMemo(() => {
    const index = orgIndex(structure);
    const options = {
      chatMemberIDs: members
        .filter((member) => member.type === "user")
        .map((member) => member.actor_id),
      excludeActorID: authorID,
    };
    if (kind === "department")
      return index.order.map((department) => {
        const count = expandDepartment(structure, department.id, options).inChat
          .length;
        const nested = (index.children.get(department.id) ?? []).length > 0;
        const path = departmentPath(structure, department.id, {
          includeSelf: false,
        });
        return {
          id: department.id,
          name: department.name,
          caption: [
            path,
            nested
              ? t("orgRequestNested", { count })
              : t("orgRequestInChat", { count }),
          ]
            .filter(Boolean)
            .join(" · "),
          count,
        };
      });
    return index.positionOrder.map((position) => {
      const count = expandPosition(structure, position.id, options).inChat
        .length;
      return {
        id: position.id,
        name: position.name,
        caption: t("orgRequestInChat", { count }),
        count,
      };
    });
  }, [authorID, kind, members, structure, t]);

  const chosen =
    audience.kind === "department"
      ? audience.departmentID
      : audience.kind === "position"
        ? audience.positionID
        : null;

  return (
    <View testID={`request-${kind}-list`}>
      {rows.map((row, position) => {
        const on = chosen === row.id;
        return (
          <Pressable
            key={row.id}
            testID={`request-${kind}-${position}`}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            accessibilityLabel={`${row.name}, ${row.caption}`}
            onPress={() =>
              onChange(
                kind === "department"
                  ? { kind: "department", departmentID: row.id }
                  : { kind: "position", positionID: row.id },
              )
            }
            style={({ pressed }) => [
              styles.option,
              pressed && { opacity: 0.6 },
            ]}
          >
            {kind === "department" ? <DepartmentIcon size={36} /> : null}
            <View style={styles.grow}>
              <Text size={15} numberOfLines={2}>
                {row.name}
              </Text>
              <Text
                tone={row.count ? "muted" : "subtle"}
                size={13}
                numberOfLines={2}
              >
                {row.caption}
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
                <Check size={14} strokeWidth={2.6} color={theme.onPrimary} />
              ) : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  // Prototype: `.opt { gap: 12px; padding: 7px 0 }`, `.opt .dsq` 36 px.
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 7,
    minHeight: 48,
  },
  grow: { flex: 1, minWidth: 0 },
  check: {
    width: 22,
    height: 22,
    borderRadius: radius.full,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
});
