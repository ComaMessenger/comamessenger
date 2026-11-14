import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  auditCategories,
  canAccessSettingsPage,
  describeAudit,
  roleLabelKey,
} from "@comamessenger/core";
import { spacing } from "@comamessenger/tokens";
import { useSignedIn } from "@/session/SessionProvider";
import { Button } from "@/ui/Button";
import { PickerSheet } from "@/ui/PickerSheet";
import { Divider, GroupBody, NavRow, SettingsGroup } from "@/ui/Settings";
import { Text } from "@/ui/Text";
import { DateRow } from "./PickerRows";
import { SettingsScreen } from "./SettingsScreen";

/** Administrative events of the workspace with the web's filters. */
export function AuditScreen() {
  const { t, i18n } = useTranslation();
  const { api, user } = useSignedIn();
  const allowed = canAccessSettingsPage(user, "audit");
  const [category, setCategory] = useState("");
  const [actorID, setActorID] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [afterID, setAfterID] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [picker, setPicker] = useState<"category" | "actor" | null>(null);
  const query = useQuery({
    queryKey: ["organization-audit", category, actorID, from, to, afterID],
    queryFn: () =>
      api.organizationAudit({
        category: category || undefined,
        actor_id: actorID || undefined,
        from: from ? new Date(`${from}T00:00:00`).toISOString() : undefined,
        to: to ? new Date(`${to}T23:59:59.999`).toISOString() : undefined,
        after_id: afterID || undefined,
      }),
    enabled: allowed,
    placeholderData: keepPreviousData,
  });
  const changeFilter = (change: () => void) => {
    change();
    setAfterID("");
    setHistory([]);
  };
  const events = query.data?.events ?? [];
  const actors = Array.from(
    new Map(
      events
        .filter((entry) => entry.actor_id)
        .map((entry) => [
          entry.actor_id!,
          entry.actor_name || t("systemActor"),
        ]),
    ),
  );
  if (actorID && !actors.some(([id]) => id === actorID))
    actors.unshift([actorID, t("auditChosenActor")]);
  const format = (iso: string) =>
    new Intl.DateTimeFormat(i18n.language, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(iso));

  return (
    <SettingsScreen
      title={t("auditLog")}
      allowed={allowed}
      query={query}
      testID="settings-audit-screen"
    >
      <SettingsGroup title={t("auditFilters")}>
        <NavRow
          testID="audit-category"
          label={t("auditCategory")}
          value={
            category ? t(`auditCategory_${category}`) : t("auditCategoryAll")
          }
          onPress={() => setPicker("category")}
        />
        <Divider />
        <NavRow
          testID="audit-actor"
          label={t("auditActor")}
          value={
            actors.find(([id]) => id === actorID)?.[1] ?? t("auditActorAll")
          }
          onPress={() => setPicker("actor")}
        />
        <Divider />
        <DateRow
          testID="audit-from"
          label={t("auditFrom")}
          value={from}
          emptyLabel={t("auditAnyDate")}
          onChange={(value) => changeFilter(() => setFrom(value))}
        />
        <Divider />
        <DateRow
          testID="audit-to"
          label={t("auditTo")}
          value={to}
          emptyLabel={t("auditAnyDate")}
          onChange={(value) => changeFilter(() => setTo(value))}
        />
      </SettingsGroup>

      <SettingsGroup title={t("auditEvents")} hint={t("auditLogHint")}>
        {events.length ? (
          events.map((entry, index) => (
            <View key={entry.id}>
              {index > 0 && <Divider />}
              <View testID={`audit-row-${index}`} accessible style={styles.row}>
                <Text size={15}>{describeAudit(entry, i18n.language)}</Text>
                <Text tone="muted" size={13}>
                  {[
                    t(`auditCategory_${entry.category}`),
                    entry.actor_role
                      ? t(roleLabelKey(entry.actor_role))
                      : t("systemActor"),
                    format(entry.created_at),
                  ].join(" · ")}
                </Text>
              </View>
            </View>
          ))
        ) : (
          <GroupBody>
            <Text tone="muted" size={14}>
              {t("auditEmpty")}
            </Text>
          </GroupBody>
        )}
      </SettingsGroup>

      {(history.length > 0 || query.data?.next_after_id) && (
        <View style={styles.pages}>
          <View style={styles.grow}>
            <Button
              testID="audit-previous"
              variant="secondary"
              label={t("previousPage")}
              disabled={history.length === 0}
              onPress={() => {
                const previous = [...history];
                setAfterID(previous.pop() ?? "");
                setHistory(previous);
              }}
            />
          </View>
          <View style={styles.grow}>
            <Button
              testID="audit-next"
              variant="secondary"
              label={t("nextPage")}
              pending={query.isFetching && query.isPlaceholderData}
              disabled={!query.data?.next_after_id}
              onPress={() => {
                setHistory((value) => [...value, afterID]);
                setAfterID(query.data?.next_after_id ?? "");
              }}
            />
          </View>
        </View>
      )}

      <PickerSheet<string>
        testID="audit-picker"
        visible={picker !== null}
        title={picker === "actor" ? t("auditActor") : t("auditCategory")}
        value={picker === "actor" ? actorID || "all" : category || "all"}
        options={
          picker === "actor"
            ? [
                { value: "all", label: t("auditActorAll") },
                ...actors.map(([id, name]) => ({ value: id, label: name })),
              ]
            : [
                { value: "all", label: t("auditCategoryAll") },
                ...auditCategories.map((value) => ({
                  value,
                  label: t(`auditCategory_${value}`),
                })),
              ]
        }
        onSelect={(value) => {
          const next = value === "all" ? "" : value;
          changeFilter(() =>
            picker === "actor" ? setActorID(next) : setCategory(next),
          );
        }}
        onClose={() => setPicker(null)}
      />
    </SettingsScreen>
  );
}

const styles = StyleSheet.create({
  row: {
    gap: spacing[1],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
  },
  pages: { flexDirection: "row", gap: spacing[3] },
  grow: { flex: 1 },
});
