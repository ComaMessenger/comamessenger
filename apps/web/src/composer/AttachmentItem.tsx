import { useEffect, useMemo } from "react";
import { AlertCircle, FileText, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cx } from "../ui";
import { formatBytes } from "../lib/format";
import type { ComposerAttachment } from "./useAttachments";

export function AttachmentItem({
  attachment,
  onCancel,
  onRetry,
}: {
  attachment: ComposerAttachment;
  onCancel(): void;
  onRetry(): void;
}) {
  const { t } = useTranslation();
  const isImage = attachment.source.type.startsWith("image/");
  const preview = useMemo(
    () => (isImage ? URL.createObjectURL(attachment.source) : null),
    [attachment.source, isImage],
  );
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );
  const failed = attachment.status === "failed";
  const uploading = attachment.status === "uploading";
  return (
    <div
      className={cx(
        "composer-attachment",
        isImage ? "composer-attachment--image" : "composer-attachment--file",
        failed && "composer-attachment--failed",
      )}
      title={attachment.source.name}
    >
      {preview ? (
        <img src={preview} alt="" />
      ) : (
        <>
          <FileText className="composer-attachment__icon" aria-hidden="true" />
          <span className="composer-attachment__copy">
            <strong className="truncate">{attachment.source.name}</strong>
            <small>
              {failed
                ? attachment.error || t("uploadFailed")
                : formatBytes(attachment.source.size)}
            </small>
          </span>
        </>
      )}
      {uploading && (
        <span className="composer-attachment__progress" aria-hidden="true">
          <span style={{ width: `${Math.round(attachment.progress * 100)}%` }} />
        </span>
      )}
      {failed && (
        <button
          type="button"
          className="composer-attachment__retry"
          onClick={onRetry}
          aria-label={`${attachment.error || t("uploadFailed")} · ${t("attachmentRetry")}`}
        >
          <AlertCircle aria-hidden="true" />
          {t("attachmentRetry")}
        </button>
      )}
      <button
        type="button"
        className="composer-attachment__remove"
        aria-label={`${t("cancel")} · ${attachment.source.name}`}
        onClick={onCancel}
      >
        <X aria-hidden="true" />
      </button>
    </div>
  );
}
