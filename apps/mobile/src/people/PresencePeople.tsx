import { useMemo } from "react";
import { ActivityIndicator, FlatList, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import {
  awayKeys,
  awayPresenceParam,
  departmentPath,
  matchesAwayPresence,
  personOrg,
  personOrgLine,
  uniquePeople,
  withCurrentAway,
  type AwayPresenceFilter,
  type OrgStructure,
} from "@comamessenger/core";
import { spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { useMessenger } from "@/messenger/MessengerProvider";
import { useSignedIn } from "@/session/SessionProvider";
import { Notice } from "@/ui/Notice";
import { Text } from "@/ui/Text";
import { useAwayNow, useAwayOverrides } from "@/status/useAway";
import { PersonRow } from "./PersonRow";

/**
 * «На месте» or «Отсутствуют» of «Люди» (phase 6.7 decision 14): the
 * server filters the directory by the time of the request (`presence`),
 * events since then and the clock decide too. Agents are neither.
 */
export function PresencePeople({
  filter,
  structure,
}: {
  filter: Exclude<AwayPresenceFilter, "all">;
  structure: OrgStructure | null;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { api, user } = useSignedIn();
  const { store } = useMessenger();
  const presence = useStore(store, (state) => state.presence);
  const overrides = useAwayOverrides();
  const query = useInfiniteQuery({
    queryKey: ["actors", ...awayKeys.people(user.id, filter)],
    queryFn: ({ pageParam }) =>
      api.actors("", pageParam, awayPresenceParam(filter)),
    initialPageParam: "",
    getNextPageParam: (page) => page.next_after_id ?? undefined,
    staleTime: 30_000,
  });
  const loaded = useMemo(
    () =>
      uniquePeople((query.data?.pages ?? []).flatMap((page) => page.actors))
        .filter((actor) => actor.actor_id !== user.id)
        .map((actor) => withCurrentAway(actor, overrides)),
    [overrides, query.data, user.id],
  );
  const now = useAwayNow(loaded.map((actor) => actor.away));
  const people = useMemo(
    () => loaded.filter((actor) => matchesAwayPresence(actor, filter, now)),
    [filter, loaded, now],
  );
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  return (
    <FlatList
      testID={`people-${filter}-list`}
      data={people}
      keyExtractor={(person) => person.actor_id}
      keyboardDismissMode="on-drag"
      onEndReached={() => {
        if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
      }}
      onEndReachedThreshold={0.5}
      renderItem={({ item, index }) => {
        const where = structure
          ? personOrg(structure, item.actor_id).primary
          : null;
        return (
          <PersonRow
            testID={`person-row-${index}`}
            person={item}
            presence={presence[item.actor_id]}
            meta={
              structure && item.type === "user"
                ? [
                    personOrgLine(item, structure),
                    where ? departmentPath(structure, where.id) : null,
                  ]
                    .filter(Boolean)
                    .join(" · ") || undefined
                : undefined
            }
            hint={t("openProfileHint")}
            onPress={() => router.push(`/people/${item.actor_id}`)}
          />
        );
      }}
      ListFooterComponent={
        isFetchingNextPage ? (
          <ActivityIndicator style={styles.loader} color={theme.muted} />
        ) : null
      }
      ListEmptyComponent={
        query.isLoading ? (
          <ActivityIndicator style={styles.loader} color={theme.muted} />
        ) : query.isError ? (
          <View style={styles.state}>
            <Notice
              title={t("peopleLoadFailed")}
              actionLabel={t("retry")}
              onAction={() => void query.refetch()}
            />
          </View>
        ) : (
          <View style={styles.state}>
            <Text weight="semibold" size={16} style={styles.center}>
              {filter === "away" ? t("peopleAwayEmpty") : t("peopleHereEmpty")}
            </Text>
            {filter === "away" ? (
              <Text tone="muted" size={14} style={styles.center}>
                {t("peopleAwayEmptyHint")}
              </Text>
            ) : null}
          </View>
        )
      }
    />
  );
}

const styles = StyleSheet.create({
  loader: { marginVertical: spacing[6] },
  state: { padding: spacing[5], gap: spacing[2] },
  center: { textAlign: "center" },
});
