import { useCallback, useEffect, useState } from "react";
import type { MessengerAPI } from "@comamessenger/core";

export type ObjectURLState = {
  url: string | null;
  /** The download failed: the file is gone, unreadable or the network is. */
  failed: boolean;
  /** Downloads again after a failure. */
  retry(): void;
};

/**
 * Downloads a file and exposes it as a revocable object URL, with the
 * failure, so a viewer shows an error and «retry» instead of loading forever.
 */
export function useObjectURLState(api: MessengerAPI, fileID?: string): ObjectURLState {
  const [url, setURL] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    let objectURL: string | null = null;
    setURL(null);
    setFailed(false);
    if (!fileID) return;
    void api
      .downloadFile(fileID)
      .then((blob) => {
        if (!active) return;
        objectURL = URL.createObjectURL(blob);
        setURL(objectURL);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
      if (objectURL) URL.revokeObjectURL(objectURL);
    };
  }, [api, fileID, attempt]);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return { url, failed, retry };
}

/** Downloads a file once and exposes it as a revocable object URL. */
export function useObjectURL(api: MessengerAPI, fileID?: string) {
  return useObjectURLState(api, fileID).url;
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
