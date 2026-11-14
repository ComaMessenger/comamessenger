import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useQueries } from "@tanstack/react-query";
import { router } from "expo-router";
import {
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Library,
  FileText,
  Paperclip,
  Plus,
  Search,
  Sheet,
  Users,
  X,
  type LucideIcon,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  isSpreadsheet,
  knowledgePath,
  knowledgeSources,
  scopesFor,
  type KnowledgeCollection,
  type KnowledgeSource,
} from "@comamessenger/core";
import { spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { useSignedIn } from "@/session/SessionProvider";
import { BottomSheet } from "@/ui/BottomSheet";
import { IconButton } from "@/ui/IconButton";
import { PickerSheet } from "@/ui/PickerSheet";
import {
  ActionRow,
  Divider,
  NavRow,
  SettingsGroup,
  SwitchRow,
} from "@/ui/Settings";
import { Text } from "@/ui/Text";
import { useAgentBuilder } from "../AgentBuilderProvider";
import { agentKeys, useCollections } from "../data";
import { StepScreen } from "../StepScreen";

const sourceIcons: Record<KnowledgeSource, LucideIcon> = {
  search: Search,
  files: Paperclip,
  members: Users,
};

type Translate = ReturnType<typeof useTranslation>["t"];

function collectionMeta(t: Translate, collection: KnowledgeCollection) {
  return [
    t("agentKnowledgeDocuments", { count: collection.document_count }),
    collection.access === "chats"
      ? t("agentKnowledgeAccessChats")
      : t("agentKnowledgeAccessAll"),
  ].join(" · ");
}

/**
 * Step 3 (web block «Что знает»): its own search, files and members of its
 * chats, the knowledge base collections and spreadsheets from them. Which
 * chats it reads is chosen on the step before.
 */
export function KnowledgeStep() {
  const { t } = useTranslation();
  const theme = useTheme();
  const { api } = useSignedIn();
  const builder = useAgentBuilder();
  const { draft, capabilities, update } = builder;
  const editable = builder.access.canBuild;
  const [adding, setAdding] = useState(false);
  const [addingTable, setAddingTable] = useState(false);
  const collections = useCollections();
  const documents = useQueries({
    queries: (collections.data ?? []).map((collection) => ({
      queryKey: agentKeys.knowledgeDocuments(collection.id),
      queryFn: () => api.knowledgeDocuments(collection.id),
    })),
  });
  const selected = draft.knowledge_collection_ids ?? [];
  const tables = draft.allowed_scopes.includes("tables:read");
  const spreadsheets = documents
    .flatMap((query) => query.data ?? [])
    .filter(isSpreadsheet);
  const bound = spreadsheets.filter((document) =>
    selected.includes(document.collection_id),
  );
  const unbound = spreadsheets.filter(
    (document) => !selected.includes(document.collection_id),
  );
  const byID = new Map(
    (collections.data ?? []).map((collection) => [collection.id, collection]),
  );
  const openBase = (collectionID?: string) =>
    router.push(knowledgePath(collectionID) as never);

  function setCollections(ids: string[], withTables?: boolean) {
    update((current) => ({
      ...current,
      knowledge_collection_ids: ids,
      allowed_scopes: scopesFor({
        capabilities,
        hasKnowledge: ids.length > 0,
        hasTables: withTables,
        current: current.allowed_scopes,
      }),
    }));
  }

  return (
    <StepScreen
      step="knowledge"
      title={t("agentBlockKnowledge")}
      lead={t("agentBlockKnowledgeHint")}
    >
      <SettingsGroup title={t("agentStepKnowledgeSources")}>
        {knowledgeSources.map((source, index) => {
          const Icon = sourceIcons[source];
          return (
            <View key={source}>
              {index > 0 && <Divider />}
              <View style={styles.iconRow}>
                <Icon size={20} color={theme.muted} style={styles.icon} />
                <View style={styles.grow}>
                  <SwitchRow
                    testID={`agent-source-${source}`}
                    label={t(`agentSource_${source}`)}
                    hint={t(`agentSourceHint_${source}`)}
                    value={capabilities.sources.includes(source)}
                    disabled={!editable}
                    onChange={(value) =>
                      builder.setCapabilities({
                        ...capabilities,
                        sources: value
                          ? [...capabilities.sources, source]
                          : capabilities.sources.filter(
                              (item) => item !== source,
                            ),
                      })
                    }
                  />
                </View>
              </View>
            </View>
          );
        })}
      </SettingsGroup>

      <SettingsGroup
        title={t("agentKnowledgeBase")}
        hint={t("agentKnowledgeBaseHint")}
      >
        {selected.map((id, index) => {
          const collection = byID.get(id);
          const name = collection?.name ?? t("agentKnowledgeUnavailable");
          return (
            <View key={id}>
              {index > 0 && <Divider />}
              <View
                style={styles.collection}
                testID={`agent-collection-${name}`}
              >
                <BookOpen size={20} color={theme.muted} />
                <View style={styles.grow}>
                  <Text size={16} weight="medium">
                    {name}
                  </Text>
                  <Text tone="muted" size={13.5}>
                    {collection
                      ? collectionMeta(t, collection)
                      : t("agentKnowledgeUnavailableHint")}
                  </Text>
                </View>
                {collection ? (
                  <IconButton
                    testID={`agent-knowledge-open-${name}`}
                    label={t("agentKnowledgeOpenCollection", { name })}
                    onPress={() => openBase(id)}
                    icon={(color) => <ChevronRight size={18} color={color} />}
                  />
                ) : null}
                {editable ? (
                  <IconButton
                    label={t("agentKnowledgeRemove", { name })}
                    onPress={() =>
                      setCollections(selected.filter((item) => item !== id))
                    }
                    icon={(color) => <X size={20} color={color} />}
                  />
                ) : null}
              </View>
            </View>
          );
        })}
        {collections.isSuccess &&
        collections.data.length === 0 &&
        selected.length === 0 ? (
          <View style={styles.collection}>
            <Text tone="muted" size={15} style={styles.grow}>
              {builder.access.canManageKnowledge
                ? t("agentKnowledgeEmptyCreate")
                : t("agentKnowledgeEmptyReadOnly")}
            </Text>
          </View>
        ) : null}
        {collections.isError ? (
          <View style={styles.collection}>
            <Text tone="muted" size={15} style={styles.grow}>
              {t("agentKnowledgeLoadFailed")}
            </Text>
          </View>
        ) : null}
        {editable && (collections.data?.length ?? 0) > 0 ? (
          <>
            {selected.length > 0 && <Divider />}
            <ActionRow
              testID="agent-knowledge-add"
              icon={Plus}
              label={t("agentKnowledgeAdd")}
              onPress={() => setAdding(true)}
            />
          </>
        ) : null}
        {collections.isSuccess &&
        (collections.data.length > 0 || builder.access.canManageKnowledge) ? (
          <>
            <Divider />
            <NavRow
              testID="agent-knowledge-open"
              icon={Library}
              label={
                collections.data.length === 0
                  ? t("agentKnowledgeCreateFirst")
                  : t("agentKnowledgeOpenBase")
              }
              onPress={() => openBase()}
            />
          </>
        ) : null}
      </SettingsGroup>

      <SettingsGroup>
        <View style={styles.iconRow}>
          <Sheet size={20} color={theme.muted} style={styles.icon} />
          <View style={styles.grow}>
            <SwitchRow
              testID="agent-tables"
              label={t("agentTables")}
              hint={
                bound.length
                  ? t("agentTablesList", {
                      names: bound.map((document) => document.title).join(", "),
                    })
                  : t("agentTablesNone")
              }
              value={tables}
              disabled={!editable}
              onChange={(value) => setCollections(selected, value)}
            />
          </View>
        </View>
        {editable && unbound.length > 0 ? (
          <>
            <Divider />
            <ActionRow
              icon={Plus}
              label={t("agentTablesAdd")}
              onPress={() => setAddingTable(true)}
            />
          </>
        ) : null}
      </SettingsGroup>

      <CollectionsSheet
        visible={adding}
        collections={collections.data ?? []}
        selected={selected}
        onClose={() => setAdding(false)}
        onToggle={(id) =>
          setCollections(
            selected.includes(id)
              ? selected.filter((item) => item !== id)
              : [...selected, id],
          )
        }
      />
      <PickerSheet
        visible={addingTable}
        title={t("agentTablesChoose")}
        value=""
        options={unbound.map((document) => ({
          value: document.id,
          label: t("agentTableOption", {
            name: document.title,
            collection: byID.get(document.collection_id)?.name ?? "",
          }),
        }))}
        onSelect={(documentID) => {
          const chosen = unbound.find((item) => item.id === documentID);
          if (chosen) setCollections([...selected, chosen.collection_id], true);
        }}
        onClose={() => setAddingTable(false)}
      />
    </StepScreen>
  );
}

/** Collections to bind, with the documents of each a tap away. */
function CollectionsSheet({
  visible,
  collections,
  selected,
  onClose,
  onToggle,
}: {
  visible: boolean;
  collections: KnowledgeCollection[];
  selected: string[];
  onClose(): void;
  onToggle(id: string): void;
}) {
  const { t } = useTranslation();
  return (
    <BottomSheet
      visible={visible}
      title={t("agentKnowledgeAdd")}
      onClose={onClose}
      testID="agent-collections-sheet"
      action={{ label: t("agentPickerDone"), onPress: onClose }}
    >
      {collections.map((collection, index) => (
        <View key={collection.id}>
          {index > 0 && <Divider />}
          <CollectionOption
            collection={collection}
            checked={selected.includes(collection.id)}
            onToggle={() => onToggle(collection.id)}
          />
        </View>
      ))}
    </BottomSheet>
  );
}

function CollectionOption({
  collection,
  checked,
  onToggle,
}: {
  collection: KnowledgeCollection;
  checked: boolean;
  onToggle(): void;
}) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const { api } = useSignedIn();
  const [expanded, setExpanded] = useState(false);
  const [documents] = useQueries({
    queries: [
      {
        queryKey: agentKeys.knowledgeDocuments(collection.id),
        queryFn: () => api.knowledgeDocuments(collection.id),
        enabled: expanded,
      },
    ],
  });
  return (
    <View>
      <View style={styles.option}>
        <Pressable
          testID={`agent-collection-option-${collection.name}`}
          accessibilityRole="checkbox"
          accessibilityState={{ checked }}
          onPress={onToggle}
          style={({ pressed }) => [
            styles.optionMain,
            pressed && { backgroundColor: theme.surfaceSelected },
          ]}
        >
          <View
            style={[
              styles.check,
              {
                borderColor: checked ? theme.primary : theme.borderStrong,
                backgroundColor: checked ? theme.primary : "transparent",
              },
            ]}
          >
            {checked ? <Check size={14} color={theme.onPrimary} /> : null}
          </View>
          <View style={styles.grow}>
            <Text size={16} weight="medium">
              {collection.name}
            </Text>
            <Text tone="muted" size={13.5}>
              {collectionMeta(t, collection)}
            </Text>
          </View>
        </Pressable>
        {collection.document_count > 0 ? (
          <IconButton
            label={
              expanded
                ? t("agentKnowledgeHideDocuments")
                : t("agentKnowledgeShowDocuments")
            }
            onPress={() => setExpanded(!expanded)}
            icon={(color) => (
              <ChevronDown
                size={20}
                color={color}
                style={expanded ? styles.rotated : undefined}
              />
            )}
          />
        ) : null}
      </View>
      {expanded ? (
        <View style={styles.documents}>
          {documents.isLoading ? (
            <Text tone="muted" size={14}>
              {t("loading")}
            </Text>
          ) : null}
          {(documents.data ?? []).map((document) => (
            <View key={document.id} style={styles.document}>
              <FileText size={16} color={theme.muted} />
              <Text size={14.5} style={styles.grow} numberOfLines={2}>
                {document.title}
              </Text>
              <Text tone="muted" size={13}>
                {document.status === "ready"
                  ? document.indexed_at
                    ? t("agentKnowledgeIndexed", {
                        date: new Date(document.indexed_at).toLocaleDateString(
                          i18n.language,
                        ),
                      })
                    : t("agentKnowledgeStatus_ready")
                  : t(`agentKnowledgeStatus_${document.status}`)}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  iconRow: { flexDirection: "row", alignItems: "center" },
  icon: { marginLeft: spacing[4] },
  grow: { flex: 1 },
  collection: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[3],
    paddingLeft: spacing[4],
    paddingRight: spacing[2],
    paddingVertical: spacing[2],
    minHeight: 56,
  },
  option: {
    flexDirection: "row",
    alignItems: "center",
    paddingRight: spacing[2],
  },
  optionMain: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
    minHeight: 56,
  },
  check: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  rotated: { transform: [{ rotate: "180deg" }] },
  documents: {
    paddingLeft: spacing[12],
    paddingRight: spacing[4],
    paddingBottom: spacing[3],
    gap: spacing[2],
  },
  document: { flexDirection: "row", alignItems: "center", gap: spacing[2] },
});
