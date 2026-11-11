import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useStore } from "zustand";
import { AlertTriangle, FileText, Paperclip, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  APIError,
  decodeMentions,
  encodeMentions,
  resolvedMentionActorIDs,
  updateMentionText,
  type ScheduledMessage,
  type UpdateScheduledMessageRequest,
} from "@comamessenger/core";
import { Button, Dialog, FormError, IconButton } from "../ui";
import { useMessenger } from "../shell/MessengerContext";
import { useToast } from "../shell/ToastProvider";
import { AttachmentItem } from "../composer/AttachmentItem";
import { attachmentLimit, useAttachments } from "../composer/useAttachments";
import { formatBytes } from "../lib/format";
import {
  ScheduleTimeFields,
  SilentToggle,
  useScheduleChoice,
} from "./ScheduleDialog";
import { formatScheduledWhen, reasonText, scheduledErrorText } from "./format";
import {
  forgetScheduled,
  scheduledQueryKey,
  storeScheduled,
} from "./useScheduled";

const sameList = (left: string[], right: string[]) =>
  left.length === right.length && left.every((value, i) => value === right[i]);

/**
 * Edits the text, attachments, time and sound of a scheduled message. The
 * change carries the version it was based on: when the message changed
 * elsewhere meanwhile, the editor reads it again and keeps what was typed.
 * A failed message is sent again by picking a new time.
 */
export function ScheduledEditor({
  item: initial,
  onClose,
}: {
  item: ScheduledMessage;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const { api, store } = useMessenger();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const presence = useStore(store, (state) => state.presence);
  const members = useQuery({
    queryKey: ["chat-members", initial.chat_id],
    queryFn: () => api.members(initial.chat_id),
    retry: false,
  });
  const failed = initial.status === "failed";
  const inThread = Boolean(initial.thread_root_id);
  const [base, setBase] = useState(initial);
  const [body, setBody] = useState(initial.body);
  const draft = decodeMentions(body);
  const [keptFiles, setKeptFiles] = useState(initial.files);
  const uploads = useAttachments(api);
  const [silent, setSilent] = useState(initial.silent);
  const [changeTime, setChangeTime] = useState(failed);
  const time = useScheduleChoice(
    failed ? undefined : new Date(initial.send_at),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const fileIDs = [
    ...keptFiles.map((file) => file.id),
    ...uploads.ready.map((item) => item.file!.id),
  ];
  const fileCount = keptFiles.length + uploads.attachments.length;
  const empty = !body.trim() && fileIDs.length === 0;

  async function save() {
    if (empty) {
      setError(t("scheduledEditorEmpty"));
      return;
    }
    if (changeTime && !time.at) {
      time.setTouched(true);
      return;
    }
    const content = body.trim();
    const input: UpdateScheduledMessageRequest = {
      expected_version: base.version,
    };
    if (content !== base.body) {
      input.body = content;
      input.body_format = "markdown";
      input.mentioned_actor_ids = resolvedMentionActorIDs(
        content,
        members.data ?? [],
        presence,
      );
    }
    const originalFiles = base.files.map((file) => file.id);
    if (!sameList(fileIDs, originalFiles)) input.file_ids = fileIDs;
    if (silent !== base.silent) input.silent = silent;
    if (changeTime && time.at) input.send_at = time.at.toISOString();
    if (Object.keys(input).length === 1) {
      onClose();
      return;
    }
    setPending(true);
    setError("");
    try {
      const record = await api.updateScheduledMessage(base.id, input);
      storeScheduled(queryClient, record);
      uploads.reset();
      onClose();
    } catch (cause) {
      if (cause instanceof APIError && cause.code === "version_conflict") {
        // Read the newer version and keep the edits on top of it.
        try {
          const fresh = await api.scheduledMessage(base.id);
          storeScheduled(queryClient, fresh);
          setBase(fresh);
          setConflict(true);
        } catch (reload) {
          closeAsGone(reload);
        }
      } else if (
        cause instanceof APIError &&
        (cause.code === "scheduled_message_closed" || cause.status === 404)
      )
        closeAsGone(cause);
      else setError(scheduledErrorText(cause));
    } finally {
      setPending(false);
    }
  }

  function closeAsGone(cause: unknown) {
    if (cause instanceof APIError && cause.status === 404)
      forgetScheduled(queryClient, base.id);
    else void queryClient.invalidateQueries({ queryKey: scheduledQueryKey });
    toast({ message: t("scheduledClosed"), tone: "danger" });
    onClose();
  }

  const reschedules = failed && changeTime;
  return (
    <Dialog
      title={t("scheduledEditorTitle")}
      onClose={onClose}
      size="md"
      sheet
      className="scheduled-editor"
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            {t("cancel")}
          </Button>
          <Button
            variant="primary"
            pending={pending}
            disabled={uploads.uploading}
            onClick={() => void save()}
          >
            {reschedules
              ? t("scheduledEditorSaveAndSchedule")
              : t("scheduledEditorSave")}
          </Button>
        </>
      }
    >
      <form
        className="scheduled-editor__form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {failed && (
          <p className="scheduled-editor__failed" role="note">
            <AlertTriangle aria-hidden="true" />
            {t("scheduledEditorFailedHint", {
              reason: reasonText(base.failure_reason),
            })}
          </p>
        )}
        {conflict && (
          <p className="scheduled-editor__conflict" role="alert">
            {t("scheduledEditorConflict")}
          </p>
        )}
        <label className="scheduled-editor__text">
          <span>{t("scheduledEditorText")}</span>
          <textarea
            rows={5}
            value={draft.text}
            onChange={(event) =>
              setBody(
                encodeMentions(updateMentionText(draft, event.target.value)),
              )
            }
          />
        </label>

        <section
          className="scheduled-editor__section"
          aria-label={t("scheduledEditorAttachments")}
        >
          <div className="scheduled-editor__section-head">
            <strong>{t("scheduledEditorAttachments")}</strong>
            {inThread ? (
              <small>{t("scheduledEditorThreadFiles")}</small>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                disabled={fileCount >= attachmentLimit}
                onClick={() => fileInput.current?.click()}
              >
                <Paperclip aria-hidden="true" />
                {t("scheduledEditorAddFiles")}
              </Button>
            )}
            <input
              ref={fileInput}
              hidden
              type="file"
              multiple
              onChange={(event) => {
                const available = attachmentLimit - fileCount;
                uploads.add(
                  [...(event.target.files ?? [])].slice(0, available),
                );
                event.target.value = "";
              }}
            />
          </div>
          {(keptFiles.length > 0 || uploads.attachments.length > 0) && (
            <div className="scheduled-editor__files">
              {keptFiles.map((file) => (
                <span key={file.id} className="scheduled-file">
                  <FileText aria-hidden="true" />
                  <span className="truncate">{file.name}</span>
                  <small>{formatBytes(file.size)}</small>
                  <IconButton
                    size="icon-sm"
                    label={t("scheduledEditorRemoveFile", { name: file.name })}
                    onClick={() =>
                      setKeptFiles((files) =>
                        files.filter((item) => item.id !== file.id),
                      )
                    }
                  >
                    <X />
                  </IconButton>
                </span>
              ))}
              {uploads.attachments.map((attachment) => (
                <AttachmentItem
                  key={attachment.id}
                  attachment={attachment}
                  onCancel={() => uploads.cancel(attachment.id)}
                  onRetry={() => uploads.retry(attachment.id)}
                />
              ))}
            </div>
          )}
        </section>

        <section
          className="scheduled-editor__section"
          aria-label={t("scheduledEditorTime")}
        >
          <div className="scheduled-editor__section-head">
            <strong>{t("scheduledEditorTime")}</strong>
            {!changeTime && (
              <>
                <span className="scheduled-editor__when">
                  {formatScheduledWhen(base.send_at)}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setChangeTime(true)}
                >
                  {t("scheduledEditorChangeTime")}
                </Button>
              </>
            )}
          </div>
          {changeTime && <ScheduleTimeFields state={time} />}
          <SilentToggle checked={silent} onChange={setSilent} />
        </section>
        {error && <FormError message={error} />}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
