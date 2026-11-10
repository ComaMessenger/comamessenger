import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { BookOpen, Download } from "lucide-react";
import { Button, Dialog, EmptyState, InlineError, SkeletonRow } from "../ui";
import { Markdown } from "../markdown";
import { useMessenger } from "../shell/MessengerContext";
import { downloadToDisk } from "../dialogs/useObjectURL";

/**
 * Read-only view of a knowledge base document cited by an agent. The web
 * knowledge section is a separate module; until it offers a document page this
 * dialog shows what GET /knowledge/documents/{id} returns: the Markdown body of
 * a page, or the file to download.
 */
export function KnowledgeDocumentDialog({
  documentID,
  title,
  excerpt,
  onClose,
}: {
  documentID: string;
  title?: string;
  excerpt?: string;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const { api } = useMessenger();
  const document = useQuery({
    queryKey: ["knowledge-document", documentID],
    queryFn: () => api.knowledgeDocument(documentID),
    retry: false,
  });
  const data = document.data;
  return (
    <Dialog
      title={data?.title ?? title ?? t("acSourceDocument")}
      onClose={onClose}
      className="knowledge-source"
      size="lg"
      footer={
        data?.kind === "file" && data.file_id ? (
          <Button
            variant="primary"
            onClick={() => void downloadToDisk(api, data.file_id!, data.file_name ?? data.title).catch(() => undefined)}
          >
            <Download aria-hidden="true" />
            {t("acDocumentDownload")}
          </Button>
        ) : undefined
      }
    >
      {excerpt && (
        <figure className="knowledge-source__excerpt">
          <figcaption>{t("acDocumentExcerpt")}</figcaption>
          <blockquote>{excerpt}</blockquote>
        </figure>
      )}
      {document.isLoading ? (
        <div aria-label={t("acDocumentLoading")}>
          <SkeletonRow />
          <SkeletonRow />
        </div>
      ) : document.isError || !data ? (
        <InlineError title={t("acDocumentFailed")} />
      ) : data.kind === "page" && data.body ? (
        <div className="knowledge-source__body">
          <Markdown source={data.body} />
        </div>
      ) : (
        <EmptyState
          compact
          icon={<BookOpen />}
          title={data.file_name ?? data.title}
          hint={data.status === "ready" || data.kind === "file" ? t("acDocumentFileHint") : t("acDocumentProcessing")}
        />
      )}
    </Dialog>
  );
}
