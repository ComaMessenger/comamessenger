import { Pressable, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { BookOpen } from "lucide-react-native";
import {
  bestFragmentPerDocument,
  splitHighlight,
  type KnowledgeFragment,
} from "@comamessenger/core";
import { spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { useSignedIn } from "@/session/SessionProvider";
import { Text } from "@/ui/Text";
import { Highlighted } from "./parts";

/**
 * Knowledge base documents as their own group of the unfiltered search, as
 * in the web search palette: one row per document, the best fragment shown.
 * The server returns only fragments of collections the reader may open.
 */
export function useKnowledgeSearchGroup(query: string, enabled: boolean) {
  const { api } = useSignedIn();
  const search = useQuery({
    queryKey: ["knowledge-search", query, 5],
    queryFn: () => api.searchKnowledge({ query, limit: 5 }),
    enabled: enabled && query.length >= 2,
    staleTime: 30_000,
    retry: false,
  });
  return enabled && query.length >= 2
    ? bestFragmentPerDocument(search.data?.fragments ?? [])
    : [];
}

export function KnowledgeSearchGroup({
  rows,
  query,
}: {
  rows: KnowledgeFragment[];
  query: string;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  if (!rows.length) return null;
  const open = (fragment: KnowledgeFragment) =>
    router.push({
      pathname: "/knowledge/[collection]/[document]",
      params: {
        collection: fragment.collection_id,
        document: fragment.document_id,
        fragment: fragment.chunk_id,
        q: query,
      },
    });
  return (
    <View testID="search-knowledge">
      <Text
        accessibilityRole="header"
        tone="muted"
        size={13}
        weight="semibold"
        style={styles.caption}
      >
        {t("kbSearchSection")}
      </Text>
      {rows.map((fragment) => (
        <Pressable
          key={fragment.chunk_id}
          accessibilityRole="button"
          onPress={() => open(fragment)}
          style={({ pressed }) => [
            styles.row,
            { borderBottomColor: theme.border },
            pressed && { backgroundColor: theme.surfaceSelected },
          ]}
        >
          <View style={styles.line}>
            <BookOpen size={16} color={theme.primary} />
            <Text size={15} weight="medium" numberOfLines={1} style={styles.grow}>
              {fragment.document_title}
            </Text>
          </View>
          <Text tone="muted" size={13} numberOfLines={1}>
            {fragment.section
              ? t("kbSearchMeta", {
                  collection: fragment.collection_name,
                  section: fragment.section,
                })
              : fragment.collection_name}
          </Text>
          <Highlighted
            parts={splitHighlight(fragment.content, query)}
            size={15}
            numberOfLines={2}
          />
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  caption: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
    paddingBottom: spacing[1],
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  row: {
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    gap: spacing[1],
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  line: { flexDirection: "row", alignItems: "center", gap: spacing[2] },
  grow: { flex: 1 },
});
