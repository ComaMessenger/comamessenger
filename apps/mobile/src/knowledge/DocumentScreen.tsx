import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { router } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react-native";
import {
  failureKey,
  fileLabel,
  focusedFragment,
  focusedParts,
  isProcessing,
  knowledgeCollectionsKey,
  knowledgeDocumentKey,
  type KnowledgeCollection,
  type KnowledgeDocument,
} from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { Markdown } from "@/conversation/Markdown";
import { messageOf } from "@/lib/errors";
import { useTheme } from "@/lib/theme";
import { useSignedIn } from "@/session/SessionProvider";
import { Button } from "@/ui/Button";
import { IconButton } from "@/ui/IconButton";
import { MenuSheet, afterSheetCloses } from "@/ui/MenuSheet";
import { Notice } from "@/ui/Notice";
import { Text } from "@/ui/Text";
import { PageEditorSheet } from "./PageEditorSheet";
import { agePhrase, bytes } from "./format";
import {
  Highlighted,
  KnowledgeScreen,
  OfflineBanner,
  Section,
  StatusBadge,
  knowledgeContent,
} from "./parts";
import {
  useCollection,
  useDocument,
  useFragments,
  useInvalidateCollection,
} from "./queries";

export type DocumentFocus = {
  fragment: string;
  query: string;
  quote: string;
  position: number | null;
};

/** One document: status, the reason of a failure, its text and fragments. */
export function DocumentScreen({
  collectionID,
  documentID,
  focus,
}: {
  collectionID: string;
  documentID: string;
  focus: DocumentFocus;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { api } = useSignedIn();
  const client = useQueryClient();
  const invalidate = useInvalidateCollection();
  const collection = useCollection(collectionID);
  const document = useDocument(documentID);
  const value = document.data;
  const fragments = useFragments(
    documentID,
    `${value?.content_version}:${value?.status}`,
    Boolean(value && value.chunk_count > 0),
  );
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const scroll = useRef<ScrollView>(null);
  const content = useRef<View>(null);
  const manage = Boolean(collection.data?.can_manage) && !document.offline;

  function confirmDelete(target: KnowledgeDocument) {
    Alert.alert(
      t("kbDeleteDocumentTitle", { name: target.title }),
      t("kbDeleteDocumentText"),
      [
        { text: t("cancel"), style: "cancel" },
        {
          text: t("kbDeleteDocument"),
          style: "destructive",
          onPress: () => void remove(),
        },
      ],
    );
  }

  async function remove() {
    try {
      await api.deleteKnowledgeDocument(documentID);
      client.removeQueries({ queryKey: knowledgeDocumentKey(documentID) });
      client.setQueryData<KnowledgeCollection[]>(
        knowledgeCollectionsKey,
        (current) =>
          current?.map((item) =>
            item.id === collectionID
              ? { ...item, document_count: Math.max(0, item.document_count - 1) }
              : item,
          ),
      );
      void invalidate(collectionID);
      router.back();
    } catch (cause) {
      setError(messageOf(cause));
    }
  }

  const meta = value
    ? [
        collection.data?.name,
        value.kind === "page" ? t("kbKindPage") : fileLabel(value),
        value.file_size ? bytes(value.file_size) : "",
        t("kbAddedBy", { age: agePhrase(value.updated_at) }),
      ].filter(Boolean)
    : [];

  return (
    <KnowledgeScreen
      testID="kb-document-screen"
      title={value?.title ?? t("kbBackToCollection")}
      subtitle={meta.join(" · ") || undefined}
      trailing={
        manage && value ? (
          <IconButton
            testID="kb-document-menu"
            label={t("kbDocumentActions")}
            onPress={() => setMenu(true)}
            icon={(color) => <MoreHorizontal size={22} color={color} />}
          />
        ) : null
      }
      query={document}
      notFound={{
        title: t("kbDocumentNotFound"),
        hint: t("kbDocumentNotFoundHint"),
      }}
    >
      {value ? (
        <ScrollView
          ref={scroll}
          contentContainerStyle={knowledgeContent}
          refreshControl={
            <RefreshControl
              refreshing={false}
              onRefresh={() => {
                void document.refetch();
                void fragments.refetch();
              }}
            />
          }
        >
          <View ref={content} style={styles.column}>
          {document.offline ? <OfflineBanner /> : null}
          <View style={styles.facts}>
            <StatusBadge status={value.status} />
            {value.status === "ready" ? (
              <Text tone="muted" size={13}>
                {t("kbChunks", { count: value.chunk_count })}
              </Text>
            ) : null}
            {value.embedding_status === "pending" ? (
              <Text tone="muted" size={13}>
                {t("kbEmbeddingPending")}
              </Text>
            ) : null}
            {value.embedding_status === "failed" ? (
              <Text tone="muted" size={13}>
                {t("kbEmbeddingFailed")}
              </Text>
            ) : null}
          </View>
          {value.status === "failed" ? (
            <Notice title={t(failureKey(value))} />
          ) : null}
          {error ? <Notice title={error} /> : null}
          {value.kind === "file" ? (
            <Button
              testID="kb-open-source"
              variant="secondary"
              label={t("kbOpenSource")}
              onPress={() =>
                router.push({
                  pathname: "/knowledge/[collection]/[document]/file",
                  params: { collection: collectionID, document: documentID },
                })
              }
            />
          ) : null}
          {value.kind === "page" && value.body && !focus.fragment ? (
            <Section title={t("kbPageContent")}>
              <View style={styles.page}>
                <Markdown source={value.body} size={15} />
              </View>
            </Section>
          ) : null}
          <Section
            title={t("kbExtractedText")}
            hint={t("kbExtractedHint")}
            card={false}
          >
            {value.chunk_count === 0 ? (
              <Text tone="muted" size={14} style={styles.note}>
                {isProcessing(value)
                  ? t("kbFragmentsPending")
                  : t("kbFragmentsEmpty")}
              </Text>
            ) : fragments.isPending ? (
              <ActivityIndicator color={theme.muted} />
            ) : fragments.isError ? (
              <Notice
                title={messageOf(fragments.error)}
                actionLabel={t("retry")}
                onAction={() => void fragments.refetch()}
              />
            ) : (
              <FragmentList
                fragments={fragments.data?.fragments ?? []}
                truncated={fragments.data?.truncated ?? false}
                focus={focus}
                onFocus={(node) => {
                  if (!content.current) return;
                  node.measureLayout(content.current, (_x, y) =>
                    scroll.current?.scrollTo({
                      y: Math.max(0, y - spacing[6]),
                      animated: true,
                    }),
                  );
                }}
              />
            )}
          </Section>
          </View>
        </ScrollView>
      ) : null}
      {value && manage ? (
        <>
          <MenuSheet
            visible={menu}
            title={value.title}
            onClose={() => setMenu(false)}
            items={[
              ...(value.kind === "page"
                ? [
                    {
                      key: "edit",
                      testID: "kb-document-edit",
                      label: t("kbEditPage"),
                      icon: <Pencil size={20} color={theme.foreground} />,
                      onPress: () => afterSheetCloses(() => setEditing(true)),
                    },
                  ]
                : []),
              {
                key: "delete",
                testID: "kb-document-delete",
                label: t("kbDeleteDocument"),
                danger: true,
                icon: <Trash2 size={20} color={theme.danger} />,
                onPress: () => afterSheetCloses(() => confirmDelete(value)),
              },
            ]}
          />
          {value.kind === "page" ? (
            <PageEditorSheet
              visible={editing}
              collectionID={collectionID}
              page={value}
              onClose={() => setEditing(false)}
              onSaved={(saved) => {
                setEditing(false);
                client.setQueryData(knowledgeDocumentKey(documentID), saved);
                void invalidate(collectionID);
              }}
            />
          ) : null}
        </>
      ) : null}
    </KnowledgeScreen>
  );
}

function FragmentList({
  fragments,
  truncated,
  focus,
  onFocus,
}: {
  fragments: Array<{
    chunk_id: string;
    position: number;
    section: string;
    content: string;
  }>;
  truncated: boolean;
  focus: DocumentFocus;
  /** The focused fragment was laid out: scroll it into view. */
  onFocus(node: View): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const focusID = focusedFragment(
    fragments,
    focus.fragment,
    focus.quote,
    focus.position,
  );
  const focused = useRef<View>(null);
  const scrolled = useRef("");
  useEffect(() => {
    scrolled.current = "";
  }, [focusID]);
  return (
    <View style={styles.fragments}>
      {fragments.map((fragment) => {
        const isFocus = fragment.chunk_id === focusID;
        return (
          <View
            key={fragment.chunk_id}
            ref={isFocus ? focused : undefined}
            testID={isFocus ? "kb-fragment-focus" : undefined}
            accessibilityState={isFocus ? { selected: true } : undefined}
            onLayout={
              isFocus
                ? () => {
                    if (scrolled.current === fragment.chunk_id || !focused.current)
                      return;
                    scrolled.current = fragment.chunk_id;
                    onFocus(focused.current);
                  }
                : undefined
            }
            style={[
              styles.fragment,
              {
                backgroundColor: theme.surface,
                borderColor: isFocus ? theme.primary : theme.border,
                borderWidth: isFocus ? 2 : 1,
              },
            ]}
          >
            <View style={styles.fragmentHead}>
              <Text tone="muted" size={12.5} weight="medium">
                {t("kbFragment", { number: fragment.position + 1 })}
              </Text>
              {fragment.section ? (
                <Text size={12.5} weight="semibold" numberOfLines={1} style={styles.grow}>
                  {fragment.section}
                </Text>
              ) : (
                <View style={styles.grow} />
              )}
              {isFocus ? (
                <View style={[styles.tag, { backgroundColor: theme.primarySoft }]}>
                  <Text size={12} weight="medium" tone="primary">
                    {focus.quote
                      ? t("kbQuotedFragment")
                      : t("kbFoundFragment")}
                  </Text>
                </View>
              ) : null}
            </View>
            {isFocus && (focus.query || focus.quote) ? (
              <Highlighted
                parts={focusedParts(fragment.content, focus)}
                size={15}
              />
            ) : (
              <Text size={15} selectable>
                {fragment.content}
              </Text>
            )}
          </View>
        );
      })}
      {truncated ? (
        <Text tone="muted" size={14}>
          {t("kbFragmentsTruncated", { count: fragments.length })}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1, minWidth: 0 },
  column: { gap: spacing[5] },
  facts: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: spacing[2],
  },
  page: { padding: spacing[4] },
  note: { paddingHorizontal: spacing[1] },
  fragments: { gap: spacing[3] },
  fragment: { borderRadius: radius.lg, padding: spacing[3], gap: spacing[2] },
  fragmentHead: { flexDirection: "row", alignItems: "center", gap: spacing[2] },
  tag: {
    paddingHorizontal: spacing[2],
    paddingVertical: 2,
    borderRadius: radius.full,
  },
});
