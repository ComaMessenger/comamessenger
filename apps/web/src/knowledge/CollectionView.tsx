import { useRef, useState, type DragEvent } from "react";
import {
  AlertCircle,
  BookOpen,
  FilePlus2,
  FileText,
  Lock,
  NotebookPen,
  Search,
  Settings2,
  Sparkles,
  Trash2,
  Upload,
  Users,
  X,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { KnowledgeCollection, KnowledgeDocument } from "@comamessenger/core";
import { Button, EmptyState, IconButton, InlineError, SkeletonRow, Tag, cx } from "../ui";
import { formatAgePhrase, formatBytes } from "../lib/format";
import { useIsMobile, useIsNarrowDesktop } from "../lib/useMediaQuery";
import { useMessenger } from "../shell/MessengerContext";
import { ConfirmDialog } from "../dialogs/ConfirmDialog";
import { DirectoryDetailHead } from "../directories/DirectoryPage";
import { messageOf } from "../errors";
import { CollectionDialog } from "./CollectionDialog";
import { PageEditorDialog } from "./PageEditorDialog";
import { acceptedDocuments, documentFormat, failureKey, isProcessing, statusKey } from "./format";
import { accessLabel, collectionKey, collectionsKey, documentsKey } from "./shared";
import { knowledgePath } from "./routes";
import { useKnowledgeUploads, type KnowledgeUpload } from "./useKnowledgeUploads";

export function CollectionView({ collectionID }: { collectionID: string }) {
  const { t } = useTranslation();
  const { api, navigate } = useMessenger();
  const client = useQueryClient();
  const isMobile = useIsMobile();
  const narrow = useIsNarrowDesktop();
  const fileInput = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [writing, setWriting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const collection = useQuery({
    queryKey: collectionKey(collectionID),
    queryFn: () => api.knowledgeCollection(collectionID),
    initialData: () =>
      client
        .getQueryData<KnowledgeCollection[]>(collectionsKey)
        ?.find((item) => item.id === collectionID),
    retry: false,
  });
  const documents = useQuery({
    queryKey: documentsKey(collectionID),
    queryFn: () => api.knowledgeDocuments(collectionID),
    enabled: collection.isSuccess,
    // Indexing is asynchronous; poll while anything is queued or processing.
    refetchInterval: (state) =>
      state.state.data?.some(isProcessing) ? 2_000 : false,
  });
  const uploads = useKnowledgeUploads(api, collectionID);
  const back = isMobile || narrow ? () => navigate(knowledgePath()) : undefined;

  if (collection.isError)
    return (
      <div className="knowledge-detail">
        <DirectoryDetailHead title={t("knowledgeBase")} onBack={back} />
        <EmptyState
          className="directory-detail__empty"
          icon={<BookOpen />}
          title={t("kbCollectionNotFound")}
          hint={t("kbCollectionNotFoundHint")}
        />
      </div>
    );
  const value = collection.data;
  if (!value)
    return (
      <div className="knowledge-detail">
        <div className="directory-detail__loading">
          <SkeletonRow lines={["60%", "40%"]} />
          <SkeletonRow lines={["80%", "50%"]} />
        </div>
      </div>
    );

  const manage = value.can_manage;

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    if (manage && event.dataTransfer.files.length) uploads.add(event.dataTransfer.files);
  }

  async function removeCollection() {
    setDeletePending(true);
    try {
      await api.deleteKnowledgeCollection(collectionID);
      client.setQueryData<KnowledgeCollection[]>(collectionsKey, (current) =>
        current?.filter((item) => item.id !== collectionID),
      );
      void client.invalidateQueries({ queryKey: collectionsKey });
      navigate(knowledgePath());
    } catch (cause) {
      setError(messageOf(cause));
      setDeleting(false);
    } finally {
      setDeletePending(false);
    }
  }

  const list = documents.data ?? [];
  return (
    <div
      className={cx("knowledge-detail", dragging && "knowledge-detail--drop")}
      onDragOver={(event) => {
        if (!manage) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <DirectoryDetailHead
        onBack={back}
        leading={
          <span className="knowledge-glyph knowledge-glyph--lg" aria-hidden="true">
            <BookOpen />
          </span>
        }
        title={value.name}
        meta={[
          t("kbDocumentCount", { count: value.document_count }),
          t("kbUpdated", { age: formatAgePhrase(value.updated_at) }),
        ].join(" · ")}
        actions={
          manage ? (
            <>
              <IconButton label={t("kbEditCollection")} onClick={() => setEditing(true)}>
                <Settings2 />
              </IconButton>
              <IconButton label={t("kbDeleteCollection")} onClick={() => setDeleting(true)}>
                <Trash2 />
              </IconButton>
            </>
          ) : (
            <Tag>{t("kbReadOnly")}</Tag>
          )
        }
      />
      <div className="knowledge-detail__scroll">
        <div className="knowledge-detail__column">
          {value.description && <p className="knowledge-description">{value.description}</p>}
          <div className="knowledge-facts">
            <span className="knowledge-fact">
              {value.access === "organization" ? <Users aria-hidden="true" /> : <Lock aria-hidden="true" />}
              {accessLabel(t, value)}
            </span>
            <span className={cx("knowledge-fact", value.semantic_search && "knowledge-fact--on")}>
              {value.semantic_search ? <Sparkles aria-hidden="true" /> : <Search aria-hidden="true" />}
              {value.semantic_search ? t("kbSemanticOn") : t("kbSemanticOff")}
            </span>
          </div>
          {error && <InlineError title={error} />}
          {manage && (
            <section className="knowledge-upload" aria-label={t("kbUploadFiles")}>
              <div className="knowledge-upload__actions">
                <Button variant="primary" onClick={() => fileInput.current?.click()}>
                  <Upload aria-hidden="true" />
                  {t("kbUploadFiles")}
                </Button>
                <Button onClick={() => setWriting(true)}>
                  <NotebookPen aria-hidden="true" />
                  {t("kbNewPage")}
                </Button>
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  hidden
                  accept={acceptedDocuments}
                  data-testid="knowledge-file-input"
                  onChange={(event) => {
                    if (event.target.files) uploads.add(event.target.files);
                    event.target.value = "";
                  }}
                />
              </div>
              <p className="knowledge-upload__hint">
                {t("kbFormatsHint", { formats: t("kbFormats") })}
                {!isMobile && ` ${t("kbDropHint")}.`}
              </p>
              {uploads.items.length > 0 && (
                <ul className="knowledge-uploads">
                  {uploads.items.map((item) => (
                    <UploadRow
                      key={item.id}
                      item={item}
                      onCancel={() => uploads.cancel(item.id)}
                      onDismiss={() => uploads.dismiss(item.id)}
                    />
                  ))}
                </ul>
              )}
            </section>
          )}
          {documents.isLoading ? (
            <>
              <SkeletonRow lines={["70%", "40%"]} />
              <SkeletonRow lines={["60%", "35%"]} />
            </>
          ) : documents.isError ? (
            <InlineError
              title={t("kbDocumentsLoadFailed")}
              onRetry={() => void documents.refetch()}
              retryLabel={t("retry")}
            />
          ) : list.length === 0 && uploads.items.length === 0 ? (
            <EmptyState
              compact={manage}
              icon={<FilePlus2 />}
              title={t("kbDocumentsEmpty")}
              hint={manage ? t("kbDocumentsEmptyManage") : t("kbDocumentsEmptyRead")}
            />
          ) : (
            <ul className="knowledge-documents" aria-label={t("kbDocumentCount", { count: list.length })}>
              {list.map((document) => (
                <DocumentRow
                  key={document.id}
                  document={document}
                  onOpen={() => navigate(knowledgePath(collectionID, document.id))}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
      {editing && (
        <CollectionDialog
          collection={value}
          onClose={() => setEditing(false)}
          onSaved={(saved) => {
            setEditing(false);
            client.setQueryData(collectionKey(collectionID), saved);
            void client.invalidateQueries({ queryKey: collectionsKey });
          }}
        />
      )}
      {writing && (
        <PageEditorDialog
          collectionID={collectionID}
          onClose={() => setWriting(false)}
          onSaved={(page) => {
            setWriting(false);
            void client.invalidateQueries({ queryKey: documentsKey(collectionID) });
            void client.invalidateQueries({ queryKey: collectionsKey });
            navigate(knowledgePath(collectionID, page.id));
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          danger
          title={t("kbDeleteCollectionTitle", { name: value.name })}
          description={t("kbDeleteCollectionText", { count: value.document_count })}
          confirmLabel={t("kbDeleteCollection")}
          pending={deletePending}
          icon={<Trash2 />}
          onConfirm={() => void removeCollection()}
          onClose={() => setDeleting(false)}
        />
      )}
    </div>
  );
}

function DocumentRow({
  document,
  onOpen,
}: {
  document: KnowledgeDocument;
  onOpen(): void;
}) {
  const { t } = useTranslation();
  const failed = document.status === "failed";
  const details = [
    document.kind === "page" ? t("kbKindPage") : fileLabel(document),
    document.file_size ? formatBytes(document.file_size) : "",
    document.status === "ready" ? t("kbChunks", { count: document.chunk_count }) : "",
    t("kbAddedBy", { age: formatAgePhrase(document.updated_at) }),
  ].filter(Boolean);
  return (
    <li>
      <button
        type="button"
        className={cx("knowledge-document", failed && "knowledge-document--failed")}
        aria-label={t("kbOpenDocument", { name: document.title })}
        onClick={onOpen}
      >
        <span className="knowledge-glyph" aria-hidden="true">
          {document.kind === "page" ? <NotebookPen /> : <FileText />}
        </span>
        <span className="knowledge-document__body">
          <strong className="truncate">{document.title}</strong>
          <small className="truncate">{details.join(" · ")}</small>
          {failed && (
            <span className="knowledge-document__error">
              <AlertCircle aria-hidden="true" />
              <span>{t(failureKey(document))}</span>
            </span>
          )}
        </span>
        <StatusBadge status={document.status} />
      </button>
    </li>
  );
}

export function StatusBadge({ status }: { status: KnowledgeDocument["status"] }) {
  const { t } = useTranslation();
  return (
    <span className={cx("knowledge-status", `knowledge-status--${status}`)}>
      {(status === "pending" || status === "processing") && (
        <span className="knowledge-status__pulse" aria-hidden="true" />
      )}
      {t(statusKey(status))}
    </span>
  );
}

function UploadRow({
  item,
  onCancel,
  onDismiss,
}: {
  item: KnowledgeUpload;
  onCancel(): void;
  onDismiss(): void;
}) {
  const { t } = useTranslation();
  const percent = Math.round(item.progress * 100);
  const status =
    item.state === "uploading"
      ? t("kbUploading", { percent })
      : item.state === "adding"
        ? t("kbUploadAdding")
        : item.state === "cancelled"
          ? t("kbUploadCancelled")
          : item.state === "rejected"
            ? t("kbUploadRejected")
            : (item.error ?? t("kbErrorUnknown"));
  const problem = item.state === "failed" || item.state === "rejected";
  return (
    <li className={cx("knowledge-upload-item", problem && "knowledge-upload-item--failed")}>
      <span className="knowledge-glyph" aria-hidden="true">
        {problem ? <AlertCircle /> : <FileText />}
      </span>
      <span className="knowledge-upload-item__body">
        <strong className="truncate">{item.name}</strong>
        <small className="truncate">
          {formatBytes(item.size)} · {status}
        </small>
        {(item.state === "uploading" || item.state === "adding") && (
          <span
            className="knowledge-progress"
            role="progressbar"
            aria-label={item.name}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <span style={{ width: `${percent}%` }} />
          </span>
        )}
      </span>
      {item.state === "uploading" ? (
        <IconButton size="icon-sm" label={t("kbCancelUpload", { name: item.name })} onClick={onCancel}>
          <X />
        </IconButton>
      ) : item.state !== "adding" ? (
        <IconButton size="icon-sm" label={t("kbDismissUpload", { name: item.name })} onClick={onDismiss}>
          <X />
        </IconButton>
      ) : null}
    </li>
  );
}

/** File name when the title differs from it, otherwise just its format. */
export function fileLabel(document: Pick<KnowledgeDocument, "title" | "file_name" | "file_mime">) {
  const name = document.file_name ?? "";
  if (name && name !== document.title) return name;
  const format = documentFormat(name, document.file_mime ?? "");
  if (format === "markdown") return "Markdown";
  if (format === "text") return "TXT";
  return format ? format.toUpperCase() : name;
}
