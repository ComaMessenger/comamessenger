import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText, Paperclip } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { FileMetadata, MessengerAPI } from "@comamessenger/core";
import { formatBytes } from "../lib/format";

export function useDownloadedObjectURL(api: MessengerAPI, fileID?: string): string | null {
  const [url, setURL] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let objectURL: string | null = null;
    setURL(null);
    if (!fileID) return;
    void api
      .downloadFile(fileID)
      .then((blob) => {
        if (!active) return;
        objectURL = URL.createObjectURL(blob);
        setURL(objectURL);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      if (objectURL) URL.revokeObjectURL(objectURL);
    };
  }, [api, fileID]);
  return url;
}

function extensionOf(name: string) {
  const match = /\.([a-z0-9]{1,5})$/i.exec(name);
  return match ? match[1]!.toUpperCase() : "";
}

/** Image preview card or a generic file card inside a message. */
export function MessageFile({ api, file }: { api: MessengerAPI; file: FileMetadata }) {
  const { t } = useTranslation();
  const metadata = useQuery({
    queryKey: ["file", file.id],
    queryFn: () => api.file(file.id),
    initialData: file,
    refetchInterval: (query) => {
      const status = query.state.data?.processing_status;
      return status === "pending" || status === "processing" ? 1500 : false;
    },
  });
  const current = metadata.data ?? file;
  const isImage = current.mime.startsWith("image/");
  const previewID = current.preview_file_id ?? (isImage ? current.id : undefined);
  const preview = useDownloadedObjectURL(api, previewID);
  async function download() {
    const blob = await api.downloadFile(current.id);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = current.name;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  const status =
    current.processing_status === "processing" || current.processing_status === "pending"
      ? t("fileProcessing")
      : current.processing_status === "failed"
        ? t("fileProcessingFailed")
        : t("download");
  if (isImage)
    return (
      <button
        type="button"
        className="message-image"
        onClick={() => void download()}
        aria-label={`${t("imageAlt", { name: current.name })} · ${formatBytes(current.size)}`}
      >
        {preview ? (
          <img src={preview} alt="" />
        ) : (
          <span className="message-image__placeholder">
            <Paperclip aria-hidden="true" />
            {current.name}
          </span>
        )}
      </button>
    );
  return (
    <button type="button" className="message-file" onClick={() => void download()}>
      <span className="message-file__icon" aria-hidden="true">
        <FileText />
      </span>
      <span className="message-file__copy">
        <strong className="truncate">{current.name}</strong>
        <small>
          {[extensionOf(current.name), formatBytes(current.size), status]
            .filter(Boolean)
            .join(" · ")}
        </small>
      </span>
    </button>
  );
}
