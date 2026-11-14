import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Download, MessageSquare, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { isSharedVideo, type ChatSharedAttachment } from "@comamessenger/core";
import { formatListTime } from "../lib/format";
import { useMessenger } from "../shell/MessengerContext";
import { downloadToDisk, useObjectURLState } from "./useObjectURL";

/**
 * Full-screen viewer of a chat's photos and videos. Opens over chat info at
 * one item; arrows (and ←/→) step through the loaded items, Esc closes.
 * Files come through the authorized download, never a public link.
 */
export function MediaViewer({
  items,
  index,
  onIndex,
  onClose,
  onOpenMessage,
}: {
  items: readonly ChatSharedAttachment[];
  index: number;
  onIndex(index: number): void;
  onClose(): void;
  onOpenMessage(item: ChatSharedAttachment): void;
}) {
  const { t } = useTranslation();
  const { api } = useMessenger();
  const item = items[index];
  const closeButton = useRef<HTMLButtonElement>(null);
  const file = useObjectURLState(api, item?.file.id);
  // The bytes came but do not decode (a broken or mislabelled file).
  const [brokenID, setBrokenID] = useState<string | null>(null);
  const failed = file.failed || (item !== undefined && brokenID === item.file.id);
  const hasPrevious = index > 0;
  const hasNext = index < items.length - 1;

  useEffect(() => {
    closeButton.current?.focus();
  }, []);
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      } else if (event.key === "ArrowLeft" && hasPrevious) onIndex(index - 1);
      else if (event.key === "ArrowRight" && hasNext) onIndex(index + 1);
    }
    // Capture: the dialog underneath must not close on the same Escape.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [hasNext, hasPrevious, index, onClose, onIndex]);

  if (!item) return null;
  const video = isSharedVideo(item);
  return createPortal(
    <div
      className="media-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={item.file.name}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <header className="media-viewer__bar">
        <span className="media-viewer__meta">
          <strong className="truncate">{item.author.display_name}</strong>
          <small>
            {formatListTime(item.created_at)} · {index + 1} / {items.length}
          </small>
        </span>
        <button
          type="button"
          className="media-viewer__action"
          aria-label={t("sharedShowInChat")}
          onClick={() => onOpenMessage(item)}
        >
          <MessageSquare aria-hidden="true" />
          <span aria-hidden="true">{t("sharedShowInChat")}</span>
        </button>
        <button
          type="button"
          className="media-viewer__icon"
          aria-label={t("download")}
          onClick={() => void downloadToDisk(api, item.file.id, item.file.name)}
        >
          <Download aria-hidden="true" />
        </button>
        <button ref={closeButton} type="button" className="media-viewer__icon" aria-label={t("close")} onClick={onClose}>
          <X aria-hidden="true" />
        </button>
      </header>
      <div className="media-viewer__stage" onClick={(event) => event.target === event.currentTarget && onClose()}>
        {failed ? (
          <div className="media-viewer__error" role="alert">
            <p>{t("sharedMediaFailed")}</p>
            <button
              type="button"
              className="media-viewer__action"
              onClick={() => {
                setBrokenID(null);
                file.retry();
              }}
            >
              {t("retry")}
            </button>
          </div>
        ) : !file.url ? (
          <span className="media-viewer__loading" aria-label={t("sharedLoading")} />
        ) : video ? (
          <video
            key={item.file.id}
            src={file.url}
            controls
            autoPlay
            className="media-viewer__media"
            onError={() => setBrokenID(item.file.id)}
          />
        ) : (
          <img
            key={item.file.id}
            src={file.url}
            alt={item.file.name}
            className="media-viewer__media"
            onError={() => setBrokenID(item.file.id)}
          />
        )}
      </div>
      {hasPrevious && (
        <button
          type="button"
          className="media-viewer__step media-viewer__step--previous"
          aria-label={t("sharedPrevious")}
          onClick={() => onIndex(index - 1)}
        >
          <ChevronLeft aria-hidden="true" />
        </button>
      )}
      {hasNext && (
        <button
          type="button"
          className="media-viewer__step media-viewer__step--next"
          aria-label={t("sharedNext")}
          onClick={() => onIndex(index + 1)}
        >
          <ChevronRight aria-hidden="true" />
        </button>
      )}
    </div>,
    document.body,
  );
}
