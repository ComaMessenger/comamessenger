import { useEffect } from "react";
import { uploadAction, type RealtimeCoordinator } from "@comamessenger/core";

/** Same cadence as typing: the server keeps an action alive for 6 seconds. */
const repeatMs = 3_000;

/**
 * Tells the chat that files are on their way while the composer uploads
 * them, and stops when the queue settles.
 */
export function useUploadActivity(
  coordinator: RealtimeCoordinator,
  chatID: string,
  threadRootID: string | null,
  attachments: readonly { status: string; source: { type: string } }[],
) {
  const action = uploadAction(
    attachments
      .filter((item) => item.status === "uploading")
      .map((item) => item.source.type),
  );
  useEffect(() => {
    if (!action) return;
    coordinator.typing(chatID, true, threadRootID, action);
    const timer = setInterval(
      () => coordinator.typing(chatID, true, threadRootID, action),
      repeatMs,
    );
    return () => {
      clearInterval(timer);
      coordinator.typing(chatID, false, threadRootID, action);
    };
  }, [action, chatID, coordinator, threadRootID]);
}
