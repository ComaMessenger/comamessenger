import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { router } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { BookOpen, FileText, NotebookPen, Plus, Search, Sparkles } from "lucide-react-native";
import {
  bestFragmentPerDocument,
  canManageKnowledge,
  knowledgeCollectionsKey,
  splitHighlight,
  type KnowledgeCollection,
  type KnowledgeFragment,
} from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { isNetworkError, messageOf } from "@/lib/errors";
import { useTheme } from "@/lib/theme";
import { useSignedIn } from "@/session/SessionProvider";
import { Button } from "@/ui/Button";
import { IconButton } from "@/ui/IconButton";
import { Notice } from "@/ui/Notice";
import { Text, fonts, maxTextScale } from "@/ui/Text";
import { CollectionSheet } from "./CollectionSheet";
import {
  CollectionRow,
  Glyph,
  Highlighted,
  KnowledgeScreen,
  OfflineBanner,
  RowDivider,
  Section,
  knowledgeContent,
} from "./parts";
import { useCollections } from "./queries";

/** Collections the reader may open, and search across all of them. */
export function KnowledgeHome() {
  const { t } = useTranslation();
  const theme = useTheme();
  const { user } = useSignedIn();
  const client = useQueryClient();
  const canManage = canManageKnowledge(user);
  const collections = useCollections();
  const [creating, setCreating] = useState(false);
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setQuery(input.trim()), 300);
    return () => clearTimeout(timer);
  }, [input]);

  const list = collections.data ?? [];
  const searching = query.length >= 2;

  return (
    <KnowledgeScreen
      testID="kb-home"
      title={t("knowledgeBase")}
      subtitle={canManage ? t("kbLead") : t("kbLeadReadOnly")}
      trailing={
        canManage ? (
          <IconButton
            testID="kb-create-collection"
            label={t("kbCreateCollection")}
            onPress={() => setCreating(true)}
            icon={(color) => <Plus size={24} color={color} />}
          />
        ) : null
      }
      query={collections}
    >
      <View style={[styles.searchBar, { borderBottomColor: theme.border, backgroundColor: theme.surface }]}>
        <View
          style={[
            styles.input,
            { backgroundColor: theme.sidebar, borderColor: theme.border },
          ]}
        >
          <Search size={20} color={theme.subtle} />
          <TextInput
            maxFontSizeMultiplier={maxTextScale}
            testID="kb-search-input"
            value={input}
            onChangeText={setInput}
            placeholder={t("kbSearchPlaceholder")}
            placeholderTextColor={theme.subtle}
            accessibilityLabel={t("kbSearchPlaceholder")}
            selectionColor={theme.primary}
            returnKeyType="search"
            clearButtonMode="while-editing"
            style={[styles.field, { color: theme.foreground }]}
          />
        </View>
      </View>
      {searching ? (
        <SearchResults query={query} />
      ) : (
        <ScrollView
          contentContainerStyle={knowledgeContent}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl
              refreshing={false}
              onRefresh={() => void collections.refetch()}
            />
          }
        >
          {collections.offline ? <OfflineBanner /> : null}
          {list.length === 0 ? (
            <View style={styles.empty} testID="kb-empty">
              <Glyph icon={BookOpen} size={56} />
              <Text weight="semibold" size={17} style={styles.center}>
                {t("kbEmptyTitle")}
              </Text>
              <Text tone="muted" size={15} style={styles.center}>
                {canManage ? t("kbEmptyManageHint") : t("kbEmptyReadHint")}
              </Text>
              {canManage ? (
                <Button
                  label={t("kbCreateCollection")}
                  onPress={() => setCreating(true)}
                />
              ) : null}
            </View>
          ) : (
            <Section title={t("kbCollections")}>
              {list.map((collection, index) => (
                <View key={collection.id}>
                  {index > 0 ? <RowDivider /> : null}
                  <CollectionRow
                    collection={collection}
                    onPress={() =>
                      router.push({
                        pathname: "/knowledge/[collection]",
                        params: { collection: collection.id },
                      })
                    }
                  />
                </View>
              ))}
            </Section>
          )}
        </ScrollView>
      )}
      <CollectionSheet
        visible={creating}
        onClose={() => setCreating(false)}
        onSaved={(created) => {
          setCreating(false);
          client.setQueryData<KnowledgeCollection[]>(
            knowledgeCollectionsKey,
            (current) =>
              [...(current ?? []), created].sort((left, right) =>
                left.name.localeCompare(right.name),
              ),
          );
          void client.invalidateQueries({ queryKey: knowledgeCollectionsKey });
          router.push({
            pathname: "/knowledge/[collection]",
            params: { collection: created.id },
          });
        }}
      />
    </KnowledgeScreen>
  );
}

function SearchResults({ query }: { query: string }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { api } = useSignedIn();
  const search = useQuery({
    queryKey: ["knowledge-search", query],
    queryFn: () => api.searchKnowledge({ query, limit: 30 }),
    staleTime: 30_000,
    retry: false,
  });
  const rows = bestFragmentPerDocument(search.data?.fragments ?? []);

  function open(fragment: KnowledgeFragment) {
    router.push({
      pathname: "/knowledge/[collection]/[document]",
      params: {
        collection: fragment.collection_id,
        document: fragment.document_id,
        fragment: fragment.chunk_id,
        q: query,
      },
    });
  }

  return (
    <ScrollView
      testID="kb-search-results"
      contentContainerStyle={knowledgeContent}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
    >
      {search.isPending ? (
        <ActivityIndicator color={theme.muted} style={styles.loader} />
      ) : search.isError ? (
        <Notice
          title={t("kbSearchFailed")}
          hint={
            isNetworkError(search.error)
              ? t("kbOfflineHint")
              : messageOf(search.error)
          }
          actionLabel={t("retry")}
          onAction={() => void search.refetch()}
        />
      ) : rows.length === 0 ? (
        <View style={styles.empty} testID="kb-search-empty">
          <Glyph icon={Search} size={56} />
          <Text weight="semibold" size={17} style={styles.center}>
            {t("kbSearchEmpty")}
          </Text>
          <Text tone="muted" size={15} style={styles.center}>
            {t("kbSearchEmptyHint")}
          </Text>
        </View>
      ) : (
        <Section
          title={t("kbSearchSection")}
          hint={t("kbSearchHint")}
        >
          {rows.map((fragment, index) => (
            <View key={fragment.chunk_id}>
              {index > 0 ? <RowDivider /> : null}
              <Pressable
                testID={`kb-result-${fragment.document_title}`}
                accessibilityRole="button"
                accessibilityLabel={[
                  fragment.document_title,
                  fragment.collection_name,
                  fragment.section,
                  fragment.content,
                ]
                  .filter(Boolean)
                  .join(", ")}
                onPress={() => open(fragment)}
                style={({ pressed }) => [
                  styles.result,
                  pressed && { backgroundColor: theme.surfaceSelected },
                ]}
              >
                <Glyph
                  icon={fragment.document_kind === "page" ? NotebookPen : FileText}
                />
                <View style={styles.grow}>
                  <Text weight="semibold" size={16} numberOfLines={1}>
                    {fragment.document_title}
                  </Text>
                  <View style={styles.meta}>
                    <Text tone="muted" size={13} numberOfLines={1} style={styles.shrink}>
                      {fragment.section
                        ? t("kbFoundIn", {
                            collection: fragment.collection_name,
                            section: fragment.section,
                          })
                        : fragment.collection_name}
                    </Text>
                    {fragment.match !== "text" ? (
                      <Sparkles
                        size={13}
                        color={theme.primary}
                        accessibilityLabel={t("kbSearchSemantic")}
                      />
                    ) : null}
                  </View>
                  <Highlighted
                    parts={splitHighlight(fragment.content, query)}
                    size={14}
                    numberOfLines={3}
                  />
                </View>
              </Pressable>
            </View>
          ))}
        </Section>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1, minWidth: 0 },
  shrink: { flexShrink: 1 },
  center: { textAlign: "center" },
  loader: { marginTop: spacing[8] },
  searchBar: {
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  input: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[2],
    minHeight: 44,
    paddingHorizontal: spacing[3],
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    width: "100%",
    maxWidth: 640,
    alignSelf: "center",
  },
  field: { flex: 1, fontFamily: fonts.regular, fontSize: 16, paddingVertical: 10 },
  empty: {
    alignItems: "center",
    gap: spacing[2],
    paddingVertical: spacing[8],
    paddingHorizontal: spacing[4],
  },
  result: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
  },
  meta: { flexDirection: "row", alignItems: "center", gap: 6 },
});
