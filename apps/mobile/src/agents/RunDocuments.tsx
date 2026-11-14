import { Pressable, StyleSheet, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { BookOpen, ChevronRight } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { knowledgePath, type KnowledgeRunFragments } from "@comamessenger/core";
import { spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { useSignedIn } from "@/session/SessionProvider";
import { Text } from "@/ui/Text";
import { agentKeys } from "./data";

export type RunDocument = KnowledgeRunFragments["fragments"][number];

/**
 * Documents of the knowledge base a finished run found, one per document
 * (the best fragment first, as the server ranks them).
 */
export function useRunDocuments(runID: string, enabled: boolean) {
  const { api } = useSignedIn();
  const fragments = useQuery({
    queryKey: agentKeys.fragments(runID),
    queryFn: () => api.knowledgeRunFragments(runID),
    enabled,
    retry: false,
  });
  const byDocument = new Map<string, RunDocument>();
  for (const fragment of fragments.data?.fragments ?? [])
    if (!byDocument.has(fragment.document_id))
      byDocument.set(fragment.document_id, fragment);
  return { documents: [...byDocument.values()], query: fragments };
}

/** The knowledge base page of a found document with its fragment in focus. */
export function runDocumentPath(document: RunDocument) {
  return knowledgePath(document.collection_id, document.document_id, {
    fragment: document.chunk_id,
    position: document.position,
  });
}

/**
 * «Found «Regulations», section …» in the trace of a run. Opens the fragment
 * in the knowledge base; a document the reader may no longer see stays text.
 */
export function RunDocumentRow({
  document,
  testID,
  compact = false,
}: {
  document: RunDocument;
  testID?: string;
  /** Smaller type for the inline trace of the builder and the Architect. */
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const label = document.section
    ? t("agentTraceDocumentSection", {
        title: document.document_title,
        section: document.section,
      })
    : t("agentTraceDocument", { title: document.document_title });
  const size = compact ? 14 : 14.5;
  if (!document.available)
    return (
      <View accessible style={[styles.row, compact && styles.compact]}>
        <BookOpen size={compact ? 16 : 18} color={theme.muted} />
        <Text size={size} tone="muted" style={styles.grow}>
          {label}
        </Text>
      </View>
    );
  return (
    <Pressable
      testID={testID}
      accessibilityRole="link"
      accessibilityLabel={label}
      accessibilityHint={t("agentTraceDocumentOpen")}
      onPress={() => router.push(runDocumentPath(document) as never)}
      style={({ pressed }) => [
        styles.row,
        compact && styles.compact,
        pressed && { backgroundColor: theme.surfaceSelected },
      ]}
    >
      <BookOpen size={compact ? 16 : 18} color={theme.primary} />
      <Text size={size} style={[styles.grow, { color: theme.primary }]}>
        {label}
      </Text>
      <ChevronRight size={16} color={theme.primary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[2],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
  },
  compact: { paddingHorizontal: 0, paddingVertical: spacing[1] },
  grow: { flex: 1 },
});
