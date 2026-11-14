import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  knowledgePageUpdate,
  knowledgePageValid,
  type KnowledgeDocument,
} from "@comamessenger/core";
import { Button, Dialog, Field, FormError, Segmented, TextareaField } from "../ui";
import { Markdown } from "../markdown";
import { messageOf } from "../errors";
import { useIsMobile } from "../lib/useMediaQuery";
import { useMessenger } from "../shell/MessengerContext";

/** Writes or edits a Markdown page; desktop shows the preview side by side. */
export function PageEditorDialog({
  collectionID,
  page,
  onClose,
  onSaved,
}: {
  collectionID: string;
  /** The page being edited, with its body; absent for a new page. */
  page?: KnowledgeDocument;
  onClose(): void;
  onSaved(document: KnowledgeDocument): void;
}) {
  const { t } = useTranslation();
  const { api } = useMessenger();
  const isMobile = useIsMobile();
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
      const saved = page
        ? await api.updateKnowledgeDocument(page.id, knowledgePageUpdate(page, title, body))
        : await api.createKnowledgeDocument(collectionID, {
            kind: "page",
            title: title.trim(),
            body,
          });
      onSaved(saved);
    } catch (cause) {
      setError(messageOf(cause));
      setPending(false);
    }
  }

  const preview = (
    <section className="knowledge-editor__preview" aria-label={t("kbPagePreview")}>
      {body.trim() ? (
        <div className="knowledge-markdown">
          <Markdown source={body} />
        </div>
      ) : (
        <p className="knowledge-form__note">{t("kbPagePreviewEmpty")}</p>
      )}
    </section>
  );
  const editor = (
    <TextareaField
      label={t("kbPageBody")}
      name="page-body"
      className="knowledge-editor__body"
      value={body}
      rows={14}
      hint={t("kbPageBodyHint")}
      onChange={(event) => setBody(event.target.value)}
    />
  );

  return (
    <Dialog
      title={page ? t("kbPageDialogEdit") : t("kbPageDialogCreate")}
      size="lg"
      className="knowledge-dialog knowledge-editor"
      onClose={onClose}
      footer={
        <>
          {page && <span className="knowledge-editor__note">{t("kbPageReindex")}</span>}
          <Button onClick={onClose} disabled={pending}>
            {t("cancel")}
          </Button>
          <Button variant="primary" pending={pending} disabled={!valid} onClick={() => void save()}>
            {page ? t("kbSave") : t("kbCreate")}
          </Button>
        </>
      }
    >
      <div className="knowledge-form">
        <Field
          label={t("kbPageTitle")}
          name="page-title"
          value={title}
          maxLength={255}
          placeholder={t("kbPageTitlePlaceholder")}
          onChange={(event) => setTitle(event.target.value)}
          autoFocus
        />
        {isMobile ? (
          <>
            <Segmented
              label={t("kbPagePreview")}
              value={mode}
              onChange={(next) => setMode(next as "write" | "preview")}
              items={[
                { id: "write", label: t("kbPageWrite") },
                { id: "preview", label: t("kbPagePreview") },
              ]}
            />
            {mode === "write" ? editor : preview}
          </>
        ) : (
          <div className="knowledge-editor__split">
            {editor}
            {preview}
          </div>
        )}
        <FormError message={error} />
      </div>
    </Dialog>
  );
}
