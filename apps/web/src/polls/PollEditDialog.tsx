import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  pollLimits,
  type Message,
  type MessagePoll,
} from "@comamessenger/core";
import { Button, Dialog, FormError } from "../ui";
import { useMessenger } from "../shell/MessengerContext";
import { useToast } from "../shell/ToastProvider";
import { pollErrorText } from "./format";

/**
 * Edit on one's own open poll (decision 12): only the question
 * changes; options, settings and the due date stay, people vote for them.
 * The card then shows the edited mark.
 */
export function PollEditDialog({
  messageID,
  poll,
  onSaved,
  onClose,
}: {
  messageID: string;
  poll: MessagePoll;
  onSaved(message: Message): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const { api } = useMessenger();
  const { toast } = useToast();
  const [question, setQuestion] = useState(poll.question);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const trimmed = question.trim();
  const tooLong = [...trimmed].length > pollLimits.questionMaxLength;
  const problem = !trimmed
    ? t("pollErrorQuestionEmpty")
    : tooLong
      ? t("pollErrorQuestionTooLong")
      : "";

  async function save() {
    if (problem) return;
    if (trimmed === poll.question) {
      onClose();
      return;
    }
    setPending(true);
    setError("");
    try {
      const message = await api.updatePoll(messageID, {
        question: trimmed,
        expected_version: poll.version,
      });
      onSaved(message);
      toast({ message: t("pollEditedToast") });
    } catch (cause) {
      setError(pollErrorText(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      title={t("pollEditTitle")}
      description={t("pollEditHint")}
      onClose={onClose}
      sheet
      size="sm"
      className="poll-edit-dialog"
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            {t("cancel")}
          </Button>
          <Button
            variant="primary"
            pending={pending}
            disabled={Boolean(problem)}
            onClick={() => void save()}
          >
            {t("pollEditSave")}
          </Button>
        </>
      }
    >
      <form
        className="request-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="request-form__field">
          <span className="request-form__label">{t("pollQuestionLabel")}</span>
          <textarea
            className="request-form__body poll-form__question"
            rows={2}
            autoFocus
            value={question}
            maxLength={pollLimits.questionMaxLength + 20}
            aria-invalid={problem ? true : undefined}
            onChange={(event) => {
              setQuestion(event.target.value);
              setError("");
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void save();
              }
            }}
          />
        </label>
        {problem && trimmed !== "" && <FormError message={problem} />}
        {error && <FormError message={error} />}
      </form>
    </Dialog>
  );
}
