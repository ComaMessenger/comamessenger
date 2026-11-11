import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { CreateScheduledMessageRequest } from "@comamessenger/core";
import { useMessenger } from "../shell/MessengerContext";
import { useToast } from "../shell/ToastProvider";
import { ScheduleDialog } from "./ScheduleDialog";
import { formatScheduledWhen, scheduledErrorText } from "./format";
import { storeScheduled } from "./useScheduled";

export type ScheduleDraft = Omit<
  CreateScheduledMessageRequest,
  "client_msg_id" | "send_at" | "silent"
>;

/**
 * "Send later" from a composer. The composer keeps its content until the
 * server has accepted the message, so a refusal loses nothing.
 */
export function ComposerScheduleDialog({
  chatID,
  draft,
  onScheduled,
  onClose,
}: {
  chatID: string;
  draft: ScheduleDraft;
  onScheduled(): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const { api, user } = useMessenger();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  // Repeating the same choice after a lost response must not schedule the
  // message twice: the key stays while the time and sound stay.
  const attempt = useRef<{ key: string; id: string } | null>(null);

  async function schedule(at: Date, silent: boolean) {
    const key = `${at.toISOString()}|${silent}`;
    if (attempt.current?.key !== key)
      attempt.current = { key, id: crypto.randomUUID() };
    setPending(true);
    setError("");
    try {
      const record = await api.createScheduledMessage(chatID, {
        ...draft,
        client_msg_id: attempt.current.id,
        send_at: at.toISOString(),
        silent,
      });
      storeScheduled(queryClient, user.id, record);
      onScheduled();
      toast({
        message: t("scheduleCreated", {
          time: formatScheduledWhen(record.send_at),
        }),
      });
      onClose();
    } catch (cause) {
      setError(scheduledErrorText(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <ScheduleDialog
      pending={pending}
      error={error}
      onConfirm={(at, silent) => void schedule(at, silent)}
      onClose={onClose}
    />
  );
}
