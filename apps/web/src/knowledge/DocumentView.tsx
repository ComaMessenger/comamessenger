import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ExternalLink,
  FileText,
  NotebookPen,
  Pencil,
  Trash2,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type { KnowledgeCollection, KnowledgeDocument } from "@comamessenger/core";
import { Button, EmptyState, IconButton, InlineError, SkeletonRow, cx } from "../ui";
import { Markdown } from "../markdown";
import { messageOf } from "../errors";
import { formatAgePhrase, formatBytes } from "../lib/format";
import { useIsMobile } from "../lib/useMediaQuery";
import { useMessenger } from "../shell/MessengerContext";
import { ConfirmDialog } from "../dialogs/ConfirmDialog";
import { DirectoryDetailHead } from "../directories/DirectoryPage";
import { PageEditorDialog } from "./PageEditorDialog";
import { StatusBadge, fileLabel } from "./CollectionView";
import { documentFormat, failureKey, isProcessing, splitHighlight } from "./format";
import { knowledgePath } from "./routes";
import {
  collectionKey,
  collectionsKey,
  documentKey,
  documentsKey,
} from "./shared";

/** One document: status, the reason of a failure, its text and fragments. */
export function DocumentView({
  collectionID,
  documentID,
}: {
  collectionID: string;
  documentID: string;
}) {
  const { t } = useTranslation();
  const { api, navigate } = useMessenger();
  const client = useQueryClient();
  const isMobile = useIsMobile();
  const search = useRouterState({ select: (state) => state.location.searchStr });
  const focus = new URLSearchParams(search);
  const focusFragment = focus.get("fragment") ?? "";
  const focusQuery = focus.get("q") ?? "";
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState("");
  const collection = useQuery({
    queryKey: collectionKey(collectionID),
    queryFn: () => api.knowledgeCollection(collectionID),
    retry: false,
  });
  const document = useQuery({
    queryKey: documentKey(documentID),
    queryFn: () => api.knowledgeDocument(documentID),
    retry: false,
    refetchInterval: (state) =>
      state.state.data && isProcessing(state.state.data) ? 2_000 : false,
  });
  const value = document.data;
  const fragments = useQuery({
    queryKey: [...documentKey(documentID), "fragments", value?.content_version, value?.status],
    queryFn: () => api.knowledgeDocumentFragments(documentID),
    enabled: Boolean(value && value.chunk_count > 0),
  });
  const back = () => navigate(knowledgePath(collectionID));

  if (document.isError)
    return (
      <div className="knowledge-detail">
        <DirectoryDetailHead title={t("kbBackToCollection")} onBack={back} />
        <EmptyState
          className="directory-detail__empty"
          icon={<FileText />}
          title={t("kbDocumentNotFound")}
          hint={t("kbDocumentNotFoundHint")}
        />
      </div>
    );
  if (!value)
    return (
      <div className="knowledge-detail">
        <div className="directory-detail__loading">
          <SkeletonRow lines={["60%", "40%"]} />
          <SkeletonRow lines={["90%", "70%"]} />
        </div>
      </div>
    );

  const manage = collection.data?.can_manage ?? false;

  async function openSource(document: KnowledgeDocument) {
    setOpening(true);
    setError("");
    // PDF and plain text open in a tab; everything else is saved. Text is
    // forced to text/plain so an uploaded HTML file never renders as a page.
    const format = documentFormat(document.file_name ?? "", document.file_mime ?? "");
    const viewType =
      format === "pdf"
        ? "application/pdf"
        : format === "text" || format === "markdown" || format === "csv"
          ? "text/plain;charset=utf-8"
          : "";
    // The tab is opened synchronously so pop-up blockers allow it.
    const tab = viewType && !isMobile ? window.open("", "_blank") : null;
    try {
      const blob = await api.downloadKnowledgeDocumentFile(document.id);
      const url = URL.createObjectURL(viewType ? new Blob([blob], { type: viewType }) : blob);
      if (tab) tab.location.href = url;
      else {
        const anchor = window.document.createElement("a");
        anchor.href = url;
        anchor.download = document.file_name ?? document.title;
        anchor.click();
      }
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (cause) {
      tab?.close();
      setError(messageOf(cause));
    } finally {
      setOpening(false);
    }
  }

  async function remove() {
    setDeletePending(true);
    try {
      await api.deleteKnowledgeDocument(documentID);
      client.removeQueries({ queryKey: documentKey(documentID) });
      void client.invalidateQueries({ queryKey: documentsKey(collectionID) });
      void client.invalidateQueries({ queryKey: collectionKey(collectionID) });
      client.setQueryData<KnowledgeCollection[]>(collectionsKey, (current) =>
        current?.map((item) =>
          item.id === collectionID
            ? { ...item, document_count: Math.max(0, item.document_count - 1) }
            : item,
        ),
      );
      back();
    } catch (cause) {
      setError(messageOf(cause));
      setDeleting(false);
      setDeletePending(false);
    }
  }

  const meta = [
    collection.data?.name,
    value.kind === "page" ? t("kbKindPage") : fileLabel(value),
    value.file_size ? formatBytes(value.file_size) : "",
    t("kbAddedBy", { age: formatAgePhrase(value.updated_at) }),
  ].filter(Boolean);

  return (
    <div className="knowledge-detail">
      <DirectoryDetailHead
        onBack={back}
        leading={
          <span className="knowledge-glyph knowledge-glyph--lg" aria-hidden="true">
            {value.kind === "page" ? <NotebookPen /> : <FileText />}
          </span>
        }
        title={value.title}
        meta={meta.join(" · ")}
        actions={
          <>
            {value.kind === "file" && (
              <Button
                size="sm"
                pending={opening}
                onClick={() => void openSource(value)}
                aria-label={t("kbOpenSource")}
              >
                <ExternalLink aria-hidden="true" />
                {!isMobile && t("kbOpenSource")}
              </Button>
            )}
            {manage && value.kind === "page" && (
              <IconButton label={t("kbEditPage")} onClick={() => setEditing(true)}>
                <Pencil />
              </IconButton>
            )}
            {manage && (
              <IconButton label={t("kbDeleteDocument")} onClick={() => setDeleting(true)}>
                <Trash2 />
              </IconButton>
            )}
          </>
        }
      />
      <div className="knowledge-detail__scroll">
        <div className="knowledge-detail__column">
          <div className="knowledge-facts">
            <StatusBadge status={value.status} />
            {value.status === "ready" && (
              <span className="knowledge-fact">{t("kbChunks", { count: value.chunk_count })}</span>
            )}
            {value.embedding_status === "pending" && (
              <span className="knowledge-fact">{t("kbEmbeddingPending")}</span>
            )}
            {value.embedding_status === "failed" && (
              <span className="knowledge-fact">{t("kbEmbeddingFailed")}</span>
            )}
          </div>
          {value.status === "failed" && (
            <p className="knowledge-notice knowledge-notice--danger" role="alert">
              <AlertCircle aria-hidden="true" />
              <span>{t(failureKey(value))}</span>
            </p>
          )}
          {error && <InlineError title={error} />}
          {value.kind === "page" && value.body && !focusFragment && (
            <section className="knowledge-section" aria-label={t("kbPageContent")}>
              <h2>{t("kbPageContent")}</h2>
              <div className="knowledge-markdown knowledge-card">
                <Markdown source={value.body} />
              </div>
            </section>
          )}
          <section className="knowledge-section" aria-label={t("kbExtractedText")}>
            <h2>{t("kbExtractedText")}</h2>
            <p className="knowledge-section__hint">{t("kbExtractedHint")}</p>
            {value.chunk_count === 0 ? (
              <p className="knowledge-form__note">
                {isProcessing(value) ? t("kbFragmentsPending") : t("kbFragmentsEmpty")}
              </p>
            ) : fragments.isLoading ? (
              <SkeletonRow lines={["90%", "60%"]} />
            ) : fragments.isError ? (
              <InlineError
                title={messageOf(fragments.error)}
                onRetry={() => void fragments.refetch()}
                retryLabel={t("retry")}
              />
            ) : (
              <FragmentList
                fragments={fragments.data?.fragments ?? []}
                truncated={fragments.data?.truncated ?? false}
                focusID={focusFragment}
                query={focusQuery}
              />
            )}
          </section>
        </div>
      </div>
      {editing && value.kind === "page" && (
        <PageEditorDialog
          collectionID={collectionID}
          page={value}
          onClose={() => setEditing(false)}
          onSaved={(saved) => {
            setEditing(false);
            client.setQueryData(documentKey(documentID), saved);
            void client.invalidateQueries({ queryKey: documentsKey(collectionID) });
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          danger
          title={t("kbDeleteDocumentTitle", { name: value.title })}
          description={t("kbDeleteDocumentText")}
          confirmLabel={t("kbDeleteDocument")}
          pending={deletePending}
          icon={<Trash2 />}
          onConfirm={() => void remove()}
          onClose={() => setDeleting(false)}
        />
      )}
    </div>
  );
}

function FragmentList({
  fragments,
  truncated,
  focusID,
  query,
}: {
  fragments: Array<{ chunk_id: string; position: number; section: string; content: string }>;
  truncated: boolean;
  focusID: string;
  query: string;
}) {
  const { t } = useTranslation();
  const focused = useRef<HTMLLIElement>(null);
  useEffect(() => {
    focused.current?.scrollIntoView({ block: "center" });
  }, [focusID, fragments.length]);
  return (
    <ol className="knowledge-fragments">
      {fragments.map((fragment) => {
        const isFocus = fragment.chunk_id === focusID;
        return (
          <li
            key={fragment.chunk_id}
            ref={isFocus ? focused : undefined}
            className={cx("knowledge-fragment", isFocus && "knowledge-fragment--focus")}
            aria-current={isFocus ? "true" : undefined}
          >
            <header>
              <span>{t("kbFragment", { number: fragment.position + 1 })}</span>
              {fragment.section && <strong className="truncate">{fragment.section}</strong>}
              {isFocus && <span className="knowledge-fragment__tag">{t("kbFoundFragment")}</span>}
            </header>
            <p>
              {isFocus && query
                ? splitHighlight(fragment.content, query).map((part, index) =>
                    part.match ? <mark key={index}>{part.text}</mark> : part.text,
                  )
                : fragment.content}
            </p>
          </li>
        );
      })}
      {truncated && (
        <li className="knowledge-form__note">
          {t("kbFragmentsTruncated", { count: fragments.length })}
        </li>
      )}
    </ol>
  );
}
