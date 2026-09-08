import { useEffect, useState } from "react";
import type { MessengerAPI } from "@comamessenger/core";

/** Downloads a file once and exposes it as a revocable object URL. */
export function useObjectURL(api: MessengerAPI, fileID?: string) {
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

export async function downloadToDisk(api: MessengerAPI, fileID: string, name: string) {
  const blob = await api.downloadFile(fileID);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
