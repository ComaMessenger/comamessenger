import { useState } from "react";
import {
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { router } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  FilePlus2,
  FileText,
  Lock,
  MoreHorizontal,
  RotateCcw,
  Search,
  Settings2,
  Sparkles,
  Trash2,
  Users,
  X,
} from "lucide-react-native";
import {
  knowledgeAccessLabel,
  knowledgeCollectionKey,
  knowledgeCollectionsKey,
  knowledgeUploadStatusKey,
  type KnowledgeCollection,
} from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { messageOf } from "@/lib/errors";
import { useTheme } from "@/lib/theme";
import { useSignedIn } from "@/session/SessionProvider";
import { Button } from "@/ui/Button";
import { IconButton } from "@/ui/IconButton";
import { MenuSheet, afterSheetCloses } from "@/ui/MenuSheet";
import { Notice } from "@/ui/Notice";
import { Text } from "@/ui/Text";
import { CollectionSheet } from "./CollectionSheet";
import { PageEditorSheet } from "./PageEditorSheet";
import { agePhrase, bytes } from "./format";
import {
  DocumentRow,
  Glyph,
  KnowledgeScreen,
  OfflineBanner,
  RowDivider,
  Section,
  knowledgeContent,
} from "./parts";
import { useCollection, useDocuments, useInvalidateCollection } from "./queries";
import {
  pickDocuments,
  useKnowledgeUploads,
  type KnowledgeUpload,
} from "./useKnowledgeUploads";

export function CollectionScreen({ collectionID }: { collectionID: string }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { api } = useSignedIn();
  const client = useQueryClient();
  const invalidate = useInvalidateCollection();
  const collection = useCollection(collectionID);
  const value = collection.data;
  const documents = useDocuments(collectionID, Boolean(value));
  const uploads = useKnowledgeUploads(collectionID);
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState("");
  const manage = Boolean(value?.can_manage) && !collection.offline;

  function confirmDelete(target: KnowledgeCollection) {
    Alert.alert(
      t("kbDeleteCollectionTitle", { name: target.name }),
      t("kbDeleteCollectionText", { count: target.document_count }),
      [
        { text: t("cancel"), style: "cancel" },
        {
          text: t("kbDeleteCollection"),
          style: "destructive",
          onPress: () => void remove(),
        },
      ],
    );
  }

  async function remove() {
    try {
      await api.deleteKnowledgeCollection(collectionID);
      client.setQueryData<KnowledgeCollection[]>(
        knowledgeCollectionsKey,
        (current) => current?.filter((item) => item.id !== collectionID),
      );
      void client.invalidateQueries({ queryKey: knowledgeCollectionsKey });
      router.back();
    } catch (cause) {
      setError(messageOf(cause));
    }
  }

  async function upload() {
    setError("");
    try {
      uploads.add(await pickDocuments());
    } catch (cause) {
      setError(messageOf(cause));
    }
  }

  const list = documents.data ?? [];
  const AccessIcon = value?.access === "organization" ? Users : Lock;
  return (
    <KnowledgeScreen
      testID="kb-collection-screen"
      title={value?.name ?? t("knowledgeBase")}
      subtitle={
        value
          ? [
              t("kbDocumentCount", { count: value.document_count }),
              t("kbUpdated", { age: agePhrase(value.updated_at) }),
            ].join(" · ")
          : undefined
      }
      trailing={
        manage ? (
          <IconButton
            testID="kb-collection-menu"
            label={t("kbCollectionActions")}
            onPress={() => setMenu(true)}
            icon={(color) => <MoreHorizontal size={22} color={color} />}
          />
        ) : null
      }
      query={collection}
      notFound={{
        title: t("kbCollectionNotFound"),
        hint: t("kbCollectionNotFoundHint"),
      }}
    >
      {value ? (
        <ScrollView
          contentContainerStyle={knowledgeContent}
          refreshControl={
            <RefreshControl
              refreshing={false}
              onRefresh={() => {
                void collection.refetch();
                void documents.refetch();
              }}
            />
          }
        >
          {collection.offline || documents.offline ? <OfflineBanner /> : null}
          {value.description ? (
            <Text size={15}>{value.description}</Text>
          ) : null}
          <View style={styles.facts}>
            <Fact icon={<AccessIcon size={14} color={theme.muted} />}>
              {knowledgeAccessLabel(t, value)}
            </Fact>
            <Fact
              icon={
                value.semantic_search ? (
                  <Sparkles size={14} color={theme.primary} />
                ) : (
                  <Search size={14} color={theme.muted} />
                )
              }
            >
              {value.semantic_search ? t("kbSemanticOn") : t("kbSemanticOff")}
            </Fact>
            {!value.can_manage ? (
              <Fact icon={<Lock size={14} color={theme.muted} />}>
                {t("kbReadOnly")}
              </Fact>
            ) : null}
          </View>
          {error ? <Notice title={error} /> : null}
          {manage ? (
            <View style={styles.upload}>
              <View style={styles.actions}>
                <View style={styles.grow}>
                  <Button
                    testID="kb-upload"
                    label={t("kbUploadFiles")}
                    onPress={() => void upload()}
                  />
                </View>
                <View style={styles.grow}>
                  <Button
                    testID="kb-new-page"
                    variant="secondary"
                    label={t("kbNewPage")}
                    onPress={() => setWriting(true)}
                  />
                </View>
              </View>
              <Text tone="subtle" size={13}>
                {t("kbFormatsHint", { formats: t("kbFormats") })}
              </Text>
            </View>
          ) : null}
          {uploads.items.length > 0 ? (
            <Section title={t("kbUploadsTitle")}>
              {uploads.items.map((item, index) => (
                <View key={item.id}>
                  {index > 0 ? <RowDivider /> : null}
                  <UploadRow
                    item={item}
                    onCancel={() => uploads.cancel(item.id)}
                    onRetry={() => uploads.retry(item.id)}
                    onDismiss={() => uploads.dismiss(item.id)}
                  />
                </View>
              ))}
            </Section>
          ) : null}
          {documents.isError ? (
            <Notice
              title={t("kbDocumentsLoadFailed")}
              hint={messageOf(documents.error)}
              actionLabel={t("retry")}
              onAction={() => void documents.refetch()}
            />
          ) : documents.isPending ? null : list.length === 0 &&
            uploads.items.length === 0 ? (
            <View style={styles.empty}>
              <Glyph icon={FilePlus2} size={56} />
              <Text weight="semibold" size={17} style={styles.center}>
                {t("kbDocumentsEmpty")}
              </Text>
              <Text tone="muted" size={15} style={styles.center}>
                {manage ? t("kbDocumentsEmptyManage") : t("kbDocumentsEmptyRead")}
              </Text>
            </View>
          ) : list.length > 0 ? (
            <Section title={t("kbDocumentCount", { count: list.length })}>
              {list.map((document, index) => (
                <View key={document.id}>
                  {index > 0 ? <RowDivider /> : null}
                  <DocumentRow
                    document={document}
                    onPress={() =>
                      router.push({
                        pathname: "/knowledge/[collection]/[document]",
                        params: { collection: collectionID, document: document.id },
                      })
                    }
                  />
                </View>
              ))}
            </Section>
          ) : null}
        </ScrollView>
      ) : null}
      {value ? (
        <>
          <MenuSheet
            visible={menu}
            title={value.name}
            onClose={() => setMenu(false)}
            items={[
              {
                key: "edit",
                testID: "kb-collection-edit",
                label: t("kbEditCollection"),
                icon: <Settings2 size={20} color={theme.foreground} />,
                onPress: () => afterSheetCloses(() => setEditing(true)),
              },
              {
                key: "delete",
                testID: "kb-collection-delete",
                label: t("kbDeleteCollection"),
                danger: true,
                icon: <Trash2 size={20} color={theme.danger} />,
                onPress: () => afterSheetCloses(() => confirmDelete(value)),
              },
            ]}
          />
          <CollectionSheet
            visible={editing}
            collection={value}
            onClose={() => setEditing(false)}
            onSaved={(saved) => {
              setEditing(false);
              client.setQueryData(knowledgeCollectionKey(collectionID), saved);
              void client.invalidateQueries({ queryKey: knowledgeCollectionsKey });
            }}
          />
          <PageEditorSheet
            visible={writing}
            collectionID={collectionID}
            onClose={() => setWriting(false)}
            onSaved={(page) => {
              setWriting(false);
              void invalidate(collectionID);
              router.push({
                pathname: "/knowledge/[collection]/[document]",
                params: { collection: collectionID, document: page.id },
              });
            }}
          />
        </>
      ) : null}
    </KnowledgeScreen>
  );
}

function Fact({ icon, children }: { icon: React.ReactNode; children: string }) {
  const theme = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={children}
      style={[styles.fact, { backgroundColor: theme.surface, borderColor: theme.border }]}
    >
      {icon}
      <Text tone="muted" size={13}>
        {children}
      </Text>
    </View>
  );
}

function UploadRow({
  item,
  onCancel,
  onRetry,
  onDismiss,
}: {
  item: KnowledgeUpload;
  onCancel(): void;
  onRetry(): void;
  onDismiss(): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const percent = Math.round(item.progress * 100);
  const statusKey = knowledgeUploadStatusKey(item.state);
  const status = statusKey
    ? t(statusKey, { percent })
    : (item.error ?? t("kbErrorUnknown"));
  const problem = item.state === "failed" || item.state === "rejected";
  const active = item.state === "uploading" || item.state === "adding";
  return (
    <View testID={`kb-upload-${item.name}`} style={styles.uploadRow}>
      <Glyph icon={problem ? AlertCircle : FileText} tone={problem ? "danger" : "primary"} />
      <View style={styles.grow}>
        <Text weight="medium" size={15} numberOfLines={1}>
          {item.name}
        </Text>
        <Text tone={problem ? "danger" : "muted"} size={13} numberOfLines={2}>
          {bytes(item.size)} · {status}
        </Text>
        {active ? (
          <View
            accessibilityRole="progressbar"
            accessibilityLabel={item.name}
            accessibilityValue={{ min: 0, max: 100, now: percent }}
            style={[styles.track, { backgroundColor: theme.surfaceSelected }]}
          >
            <View
              style={[
                styles.bar,
                { width: `${percent}%`, backgroundColor: theme.primary },
              ]}
            />
          </View>
        ) : null}
      </View>
      {item.state === "failed" || item.state === "cancelled" ? (
        <IconButton
          testID={`kb-upload-retry-${item.name}`}
          label={t("kbRetryUpload", { name: item.name })}
          onPress={onRetry}
          icon={(color) => <RotateCcw size={20} color={color} />}
        />
      ) : null}
      {item.state === "uploading" ? (
        <IconButton
          label={t("kbCancelUpload", { name: item.name })}
          onPress={onCancel}
          icon={(color) => <X size={20} color={color} />}
        />
      ) : item.state !== "adding" ? (
        <IconButton
          label={t("kbDismissUpload", { name: item.name })}
          onPress={onDismiss}
          icon={(color) => <X size={20} color={color} />}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1, minWidth: 0 },
  center: { textAlign: "center" },
  facts: { flexDirection: "row", flexWrap: "wrap", gap: spacing[2] },
  fact: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: spacing[3],
    paddingVertical: 6,
    borderRadius: radius.full,
    borderWidth: StyleSheet.hairlineWidth,
  },
  upload: { gap: spacing[2] },
  actions: { flexDirection: "row", gap: spacing[2], flexWrap: "wrap" },
  empty: {
    alignItems: "center",
    gap: spacing[2],
    paddingVertical: spacing[6],
    paddingHorizontal: spacing[4],
  },
  uploadRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
  },
  track: {
    height: 4,
    borderRadius: 2,
    marginTop: 6,
    overflow: "hidden",
  },
  bar: { height: 4, borderRadius: 2 },
});
