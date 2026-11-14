import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  typingScope,
  uploadAction,
  type TypingAction,
} from "@comamessenger/core";
import { useMessenger } from "@/messenger/MessengerProvider";
import { useUploadJobs } from "@/files/uploadJobs";

/** Same cadence as typing: the server keeps an action alive for 6 seconds. */
const repeatMs = 3_000;

/**
 * Tells the chat what this person is doing ("recording a voice message",
 * "sending a photo") while `action` is set, and that they stopped after.
 */
export function useChatActivity(
  chatID: string | undefined,
  threadRootID: string | null,
  action: TypingAction | null,
) {
  const { coordinator } = useMessenger();
  useEffect(() => {
    if (!chatID || !action) return;
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

/**
 * Files on their way to this chat, also after the message that carries them
 * has left the composer.
 */
export function useUploadActivity(chatID: string, threadRootID: string | null) {
  const scope = typingScope(chatID, threadRootID);
  const types = useUploadJobs(
    useShallow((state) =>
      Object.values(state.jobs)
        .filter((job) => job.scope === scope && job.status === "uploading")
        .map((job) => job.local.mime),
    ),
  );
  useChatActivity(chatID, threadRootID, uploadAction(types));
}
