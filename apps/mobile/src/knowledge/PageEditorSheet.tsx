import { useEffect, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { useTranslation } from "react-i18next";
import {
  knowledgePageUpdate,
  knowledgePageValid,
  type KnowledgeDocument,
} from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { Markdown } from "@/conversation/Markdown";
import { messageOf } from "@/lib/errors";
import { useTheme } from "@/lib/theme";
import { useSignedIn } from "@/session/SessionProvider";
import { Notice } from "@/ui/Notice";
import { PageSheet } from "@/ui/PageSheet";
import { TabChip } from "@/ui/TabChip";
import { Text } from "@/ui/Text";
import { TextField } from "@/ui/TextField";
import { HeaderAction } from "./HeaderAction";

/** Writes or edits a Markdown page; «Текст» and «Предпросмотр» switch places. */
export function PageEditorSheet({
  visible,
  collectionID,
  page,
  onClose,
  onSaved,
}: {
  visible: boolean;
  collectionID: string;
  /** The page being edited, with its body; absent for a new page. */
  page?: KnowledgeDocument;
  onClose(): void;
  onSaved(document: KnowledgeDocument): void;
}) {
  const [session, setSession] = useState(0);
  useEffect(() => {
    if (visible) setSession((value) => value + 1);
  }, [visible]);
  return (
    <PageEditor
      key={session}
      visible={visible}
      collectionID={collectionID}
      page={page}
      onClose={onClose}
      onSaved={onSaved}
    />
  );
}

function PageEditor({
  visible,
  collectionID,
  page,
  onClose,
  onSaved,
}: {
  visible: boolean;
  collectionID: string;
  page?: KnowledgeDocument;
  onClose(): void;
  onSaved(document: KnowledgeDocument): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { api } = useSignedIn();
  const [title, setTitle] = useState(page?.title ?? "");
  const [body, setBody] = useState(page?.body ?? "");
  const [mode, setMode] = useState<"write" | "preview">("write");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const valid = knowledgePageValid(title, body);

  async function save() {
    if (!valid) {
      setError(t("kbPageRequired"));
      return;
    }
    setPending(true);
    setError("");
    try {
      onSaved(
        page
          ? await api.updateKnowledgeDocument(
              page.id,
              knowledgePageUpdate(page, title, body),
            )
          : await api.createKnowledgeDocument(collectionID, {
              kind: "page",
              title: title.trim(),
              body,
            }),
      );
    } catch (cause) {
      setError(messageOf(cause));
      setPending(false);
    }
  }

  return (
    <PageSheet
      visible={visible}
      title={page ? t("kbPageDialogEdit") : t("kbPageDialogCreate")}
      subtitle={page ? t("kbPageReindex") : undefined}
      onClose={onClose}
      testID="kb-page-sheet"
      trailing={
        <HeaderAction
          testID="kb-page-save"
          label={page ? t("kbSave") : t("kbCreate")}
          pending={pending}
          disabled={!valid}
          onPress={() => void save()}
        />
      }
    >
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
        >
          <TextField
            testID="kb-page-title"
            label={t("kbPageTitle")}
            value={title}
            maxLength={255}
            placeholder={t("kbPageTitlePlaceholder")}
            onChangeText={setTitle}
            autoFocus={!page}
          />
          <View accessibilityRole="tablist" style={styles.tabs}>
            <TabChip
              testID="kb-page-write"
              label={t("kbPageWrite")}
              selected={mode === "write"}
              onPress={() => setMode("write")}
            />
            <TabChip
              testID="kb-page-preview"
              label={t("kbPagePreview")}
              selected={mode === "preview"}
              onPress={() => setMode("preview")}
            />
          </View>
          {mode === "write" ? (
            <TextField
              testID="kb-page-body"
              label={t("kbPageBody")}
              hint={t("kbPageBodyHint")}
              value={body}
              onChangeText={setBody}
              multiline
              scrollEnabled={false}
              autoCapitalize="sentences"
            />
          ) : (
            <View
              accessibilityLabel={t("kbPagePreview")}
              style={[
                styles.preview,
                { backgroundColor: theme.surface, borderColor: theme.border },
              ]}
            >
              {body.trim() ? (
                <Markdown source={body} size={15} />
              ) : (
                <Text tone="muted" size={14}>
                  {t("kbPagePreviewEmpty")}
                </Text>
              )}
            </View>
          )}
          {error ? <Notice title={error} /> : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </PageSheet>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: {
    padding: spacing[4],
    paddingBottom: spacing[8],
    gap: spacing[4],
    width: "100%",
    maxWidth: 640,
    alignSelf: "center",
  },
  tabs: { flexDirection: "row", gap: spacing[2] },
  preview: {
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing[3],
    minHeight: 200,
  },
});
