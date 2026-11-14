import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  AlertCircle,
  BookOpen,
  ChevronRight,
  CloudOff,
  FileText,
  Lock,
  NotebookPen,
  Sparkles,
  Users,
  type LucideIcon,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  APIError,
  failureKey,
  fileLabel,
  knowledgeAccessLabel,
  statusKey,
  type KnowledgeCollection,
  type KnowledgeDocument,
} from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { isNetworkError, messageOf } from "@/lib/errors";
import { useTheme } from "@/lib/theme";
import { Notice } from "@/ui/Notice";
import { ScreenHeader } from "@/ui/ScreenHeader";
import { Text } from "@/ui/Text";
import { agePhrase, bytes } from "./format";

/** Rounded tile with the icon of a collection, a document or a page. */
export function Glyph({
  icon: Icon,
  size = 40,
  tone = "primary",
}: {
  icon: LucideIcon;
  size?: number;
  tone?: "primary" | "danger";
}) {
  const theme = useTheme();
  return (
    <View
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={[
        styles.glyph,
        {
          width: size,
          height: size,
          borderRadius: size * 0.3,
          backgroundColor:
            tone === "danger" ? theme.dangerSoft : theme.primarySoft,
        },
      ]}
    >
      <Icon
        size={size * 0.5}
        color={tone === "danger" ? theme.danger : theme.primary}
      />
    </View>
  );
}

export function documentIcon(document: Pick<KnowledgeDocument, "kind">) {
  return document.kind === "page" ? NotebookPen : FileText;
}

/** «В очереди», «Обрабатывается», «Готово», «Ошибка» as a coloured pill. */
export function StatusBadge({
  status,
}: {
  status: KnowledgeDocument["status"];
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const colors = {
    pending: { background: theme.surfaceSelected, text: theme.muted },
    processing: { background: theme.infoSoft, text: theme.info },
    ready: { background: theme.successSoft, text: theme.successText },
    failed: { background: theme.dangerSoft, text: theme.danger },
  }[status];
  return (
    <View
      testID={`kb-status-${status}`}
      style={[styles.badge, { backgroundColor: colors.background }]}
    >
      {status === "pending" || status === "processing" ? (
        <ActivityIndicator size="small" color={colors.text} />
      ) : null}
      <Text weight="medium" size={12.5} style={{ color: colors.text }}>
        {t(statusKey(status))}
      </Text>
    </View>
  );
}

export function documentDetails(
  t: (key: string, options?: Record<string, unknown>) => string,
  document: KnowledgeDocument,
) {
  return [
    document.kind === "page" ? t("kbKindPage") : fileLabel(document),
    document.file_size ? bytes(document.file_size) : "",
    document.status === "ready"
      ? t("kbChunks", { count: document.chunk_count })
      : "",
    t("kbAddedBy", { age: agePhrase(document.updated_at) }),
  ].filter(Boolean);
}

export function DocumentRow({
  document,
  onPress,
}: {
  document: KnowledgeDocument;
  onPress(): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const failed = document.status === "failed";
  const details = documentDetails(t, document).join(" · ");
  return (
    <Pressable
      testID={`kb-document-${document.title}`}
      accessibilityRole="button"
      accessibilityLabel={[
        document.title,
        t(statusKey(document.status)),
        details,
        failed ? t(failureKey(document)) : "",
      ]
        .filter(Boolean)
        .join(", ")}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        pressed && { backgroundColor: theme.surfaceSelected },
      ]}
    >
      <Glyph icon={documentIcon(document)} tone={failed ? "danger" : "primary"} />
      <View style={styles.grow}>
        <Text weight="medium" size={16} numberOfLines={2}>
          {document.title}
        </Text>
        <Text tone="muted" size={13.5} numberOfLines={1}>
          {details}
        </Text>
        {failed ? (
          <View style={styles.error}>
            <AlertCircle size={14} color={theme.danger} />
            <Text tone="danger" size={13.5} style={styles.grow}>
              {t(failureKey(document))}
            </Text>
          </View>
        ) : null}
      </View>
      <StatusBadge status={document.status} />
    </Pressable>
  );
}

export function CollectionRow({
  collection,
  onPress,
}: {
  collection: KnowledgeCollection;
  onPress(): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const access = knowledgeAccessLabel(t, collection);
  const AccessIcon = collection.access === "organization" ? Users : Lock;
  return (
    <Pressable
      testID={`kb-collection-${collection.name}`}
      accessibilityRole="button"
      accessibilityLabel={[
        collection.name,
        collection.description,
        t("kbDocumentCount", { count: collection.document_count }),
        access,
        collection.semantic_search ? t("kbSemanticOn") : "",
      ]
        .filter(Boolean)
        .join(", ")}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        pressed && { backgroundColor: theme.surfaceSelected },
      ]}
    >
      <Glyph icon={BookOpen} />
      <View style={styles.grow}>
        <View style={styles.top}>
          <Text weight="semibold" size={16} numberOfLines={1} style={styles.grow}>
            {collection.name}
          </Text>
          <Text tone="subtle" size={13}>
            {agePhrase(collection.updated_at)}
          </Text>
        </View>
        {collection.description ? (
          <Text tone="muted" size={14} numberOfLines={2}>
            {collection.description}
          </Text>
        ) : null}
        <View style={styles.meta}>
          <Text tone="subtle" size={13}>
            {t("kbDocumentCount", { count: collection.document_count })}
          </Text>
          <View style={styles.fact}>
            <AccessIcon size={13} color={theme.subtle} />
            <Text tone="subtle" size={13} numberOfLines={1}>
              {access}
            </Text>
          </View>
          {collection.semantic_search ? (
            <Sparkles size={13} color={theme.primary} />
          ) : null}
        </View>
      </View>
      <ChevronRight size={20} color={theme.subtle} />
    </Pressable>
  );
}

/** Text with the matching parts marked, as `<mark>` on the web. */
export function Highlighted({
  parts,
  size = 15,
  numberOfLines,
}: {
  parts: Array<{ text: string; match: boolean }>;
  size?: number;
  numberOfLines?: number;
}) {
  const theme = useTheme();
  return (
    <Text size={size} numberOfLines={numberOfLines}>
      {parts.map((part, index) =>
        part.match ? (
          <Text
            key={index}
            size={size}
            weight="semibold"
            style={{ backgroundColor: theme.warningSoft }}
          >
            {part.text}
          </Text>
        ) : (
          part.text
        ),
      )}
    </Text>
  );
}

/** A labelled list inside a card, like a settings group. */
export function Section({
  title,
  hint,
  children,
  card = true,
}: {
  title?: string;
  hint?: string;
  children: ReactNode;
  card?: boolean;
}) {
  const theme = useTheme();
  return (
    <View style={styles.section}>
      {title ? (
        <Text
          accessibilityRole="header"
          tone="muted"
          size={13}
          weight="medium"
          style={styles.caption}
        >
          {title}
        </Text>
      ) : null}
      {hint ? (
        <Text tone="subtle" size={13} style={styles.caption}>
          {hint}
        </Text>
      ) : null}
      {card ? (
        <View
          style={[
            styles.card,
            { backgroundColor: theme.surface, borderColor: theme.border },
          ]}
        >
          {children}
        </View>
      ) : (
        children
      )}
    </View>
  );
}

export function RowDivider() {
  const theme = useTheme();
  return (
    <View style={[styles.divider, { backgroundColor: theme.border }]} />
  );
}

/** «Нет связи — показана сохранённая копия». */
export function OfflineBanner() {
  const { t } = useTranslation();
  const theme = useTheme();
  return (
    <View
      testID="kb-offline"
      accessibilityRole="alert"
      style={[styles.offline, { backgroundColor: theme.sidebar, borderColor: theme.border }]}
    >
      <CloudOff size={16} color={theme.muted} />
      <Text tone="muted" size={13.5} style={styles.grow}>
        {t("kbOfflineCopy")}
      </Text>
    </View>
  );
}

type Loadable = {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  refetch(): unknown;
  lookingForCopy?: boolean;
};

/**
 * A knowledge screen: header, then the content, or what stands in for it —
 * loading, «not found» (deleted or access removed), offline or a failed load
 * with «Повторить».
 */
export function KnowledgeScreen({
  title,
  subtitle,
  leading,
  trailing,
  testID,
  query,
  notFound,
  children,
}: {
  title: string;
  subtitle?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  testID?: string;
  query: Loadable;
  /** Title and hint shown for a 404. */
  notFound?: { title: string; hint: string };
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  let body: ReactNode = children;
  if (query.isError && !query.lookingForCopy) {
    const missing =
      notFound &&
      query.error instanceof APIError &&
      (query.error.status === 404 || query.error.status === 403);
    const offline = isNetworkError(query.error);
    body = (
      <View style={styles.state}>
        {missing ? (
          <Notice tone="neutral" title={notFound.title} hint={notFound.hint} />
        ) : (
          <Notice
            title={offline ? t("kbOffline") : t("kbLoadFailed")}
            hint={offline ? t("kbOfflineHint") : messageOf(query.error)}
            actionLabel={t("retry")}
            onAction={() => void query.refetch()}
          />
        )}
      </View>
    );
  } else if (query.isPending || query.lookingForCopy)
    body = <ActivityIndicator style={styles.loader} color={theme.muted} />;
  return (
    <SafeAreaView
      testID={testID}
      edges={["bottom"]}
      style={[styles.screen, { backgroundColor: theme.canvas }]}
    >
      <ScreenHeader
        title={title}
        subtitle={subtitle}
        leading={leading}
        trailing={trailing}
        backTestID="kb-back"
      />
      {body}
    </SafeAreaView>
  );
}

export const knowledgeContent = {
  padding: spacing[4],
  paddingBottom: spacing[8],
  gap: spacing[5],
  width: "100%",
  maxWidth: 640,
  alignSelf: "center",
} as const;

const styles = StyleSheet.create({
  screen: { flex: 1 },
  state: { padding: spacing[4] },
  loader: { marginTop: spacing[10] },
  glyph: { alignItems: "center", justifyContent: "center" },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: spacing[2],
    paddingVertical: 3,
    borderRadius: radius.full,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    minHeight: 64,
  },
  grow: { flex: 1, minWidth: 0 },
  top: { flexDirection: "row", alignItems: "center", gap: spacing[2] },
  meta: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    columnGap: spacing[3],
    rowGap: 2,
    marginTop: 2,
  },
  fact: { flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1 },
  error: { flexDirection: "row", gap: 4, marginTop: 2, alignItems: "flex-start" },
  section: { gap: spacing[2] },
  caption: { paddingHorizontal: spacing[1] },
  card: { borderWidth: 1, borderRadius: radius.lg, overflow: "hidden" },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 68 },
  offline: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[2],
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
  },
});
