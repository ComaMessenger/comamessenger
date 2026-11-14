import { useEffect } from "react";
import type { RealtimeCoordinator, TypingAction } from "@comamessenger/core";

/** Same cadence as typing: the server keeps an action alive for 6 seconds. */
const repeatMs = 3_000;

/** "Sending photo/video/file" from the kinds of files being uploaded. */
export function uploadAction(types: readonly string[]): TypingAction | null {
  if (!types.length) return null;
  if (types.every((type) => type.startsWith("image/"))) return "uploading_photo";
  if (types.every((type) => type.startsWith("video/"))) return "uploading_video";
  return "uploading_file";
}

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
