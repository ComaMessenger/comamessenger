import { useState } from "react";
import { Bell, Check, MessageSquareMore, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  formatRequestDue,
  requestAudienceText,
  requestLimits,
  requestView,
  type Message,
  type MessageRequestViewer,
  type RequestView,
} from "@comamessenger/core";
import { Button, cx } from "../ui";
import { Markdown } from "../markdown";
import { ConfirmDialog } from "../dialogs/ConfirmDialog";
import { calendarLocale } from "./format";

export type RequestCardActions = {
  answer(option: number, comment?: string): Promise<boolean>;
  close(): Promise<boolean>;
  remind(): Promise<boolean>;
  busy: "answer" | "close" | "remind" | null;
};

/**
 * The request in the feed, for the three kinds of reader: the recipient
 * answers with one tap (then Your answer, Change, a comment), the
 * author sees the bars, N of M answered, Remind and Details,
 * everyone else sees your answer is not expected. Pure: the row passes the
 * viewer and the actions.
 */
export function RequestCard({
  message,
  viewer,
  selfID,
  actions,
  onOpenAnswers,
  now = new Date(),
}: {
  message: Pick<Message, "id" | "actor_id" | "edited_at" | "request" | "body">;
  viewer: MessageRequestViewer | null;
  selfID: string;
  actions: RequestCardActions;
  /** Details: who answered what. */
  onOpenAnswers?(): void;
  now?: Date;
}) {
  const { t } = useTranslation();
  const locale = calendarLocale();
  const view = requestView(message, viewer, { selfID, now, t });
  const [changing, setChanging] = useState(false);
  const [commenting, setCommenting] = useState(false);
  const [comment, setComment] = useState("");
  const [confirmClose, setConfirmClose] = useState(false);
  if (!view) return null;
  const due = (at: Date) => formatRequestDue(at, now, locale);
  const showButtons =
    view.showButtons || (changing && view.canChange && view.answer !== null);

  async function pick(option: number) {
    const done = await actions.answer(option);
    if (done) setChanging(false);
  }
  async function saveComment() {
    if (!view?.answer) return;
    const done = await actions.answer(view.answer.option, comment.trim());
    if (done) setCommenting(false);
  }

  return (
    <div
      className={cx(
        "request-card",
        !view.open && "request-card--closed",
        view.role === "author" && "request-card--author",
      )}
      data-request-role={view.role}
    >
      <div className="request-card__head">
        <MessageSquareMore aria-hidden="true" />
        <span>{t("requestCardLabel")}</span>
        <RequestPill view={view} due={due} />
      </div>
      <div className="request-card__to">
        {view.audience.kind === "people" && !view.audience.label
          ? // The number of people already says how many.
            t("requestAudienceLineCounted", {
              audience: requestAudienceText(view.audience, locale),
            })
          : t("requestAudienceLine", {
              audience: requestAudienceText(view.audience, locale),
              count: view.total,
            })}
      </div>
      <div className="request-card__text">
        <Markdown source={message.body} />
      </div>

      {showButtons && (
        <RequestButtons
          options={view.options}
          selected={changing ? view.answer?.option : undefined}
          disabled={actions.busy === "answer"}
          onPick={(option) => void pick(option)}
        />
      )}
      {changing && (
        <button
          type="button"
          className="request-card__link"
          onClick={() => setChanging(false)}
        >
          {t("requestChangeCancel")}
        </button>
      )}

      {view.answer && !changing && (
        <div className="request-card__answer">
          <Check aria-hidden="true" />
          <span>
            {t("requestYourAnswer", { answer: view.answer.label })}
            {view.answer.late && (
              <span className="request-card__late">
                {" · "}
                {t("requestLate")}
              </span>
            )}
          </span>
          {view.canChange && (
            <button
              type="button"
              className="request-card__link"
              onClick={() => {
                setCommenting(false);
                setChanging(true);
              }}
            >
              {t("requestChange")}
            </button>
          )}
        </div>
      )}
      {view.answer && !changing && (view.answer.comment || view.canComment) && (
        <div className="request-card__comment">
          {commenting ? (
            <form
              className="request-card__comment-form"
              onSubmit={(event) => {
                event.preventDefault();
                void saveComment();
              }}
            >
              <input
                className="request-input"
                value={comment}
                autoFocus
                maxLength={requestLimits.commentMaxLength}
                aria-label={t("requestCommentLabel")}
                placeholder={t("requestCommentPlaceholder")}
                onChange={(event) => setComment(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setCommenting(false);
                }}
              />
              <Button
                type="submit"
                size="sm"
                variant="primary"
                pending={actions.busy === "answer"}
              >
                {t("requestCommentSave")}
              </Button>
            </form>
          ) : view.answer.comment ? (
            <span>
              {t("requestYourComment")} <strong>{view.answer.comment}</strong>
              {view.canComment && (
                <button
                  type="button"
                  className="request-card__link"
                  onClick={() => {
                    setComment(view.answer?.comment ?? "");
                    setCommenting(true);
                  }}
                >
                  {t("requestChange")}
                </button>
              )}
            </span>
          ) : (
            <button
              type="button"
              className="request-card__link request-card__link--strong"
              onClick={() => {
                setComment("");
                setCommenting(true);
              }}
            >
              {t("requestAddComment")}
            </button>
          )}
        </div>
      )}

      {view.notForYou && (
        <div className="request-card__out">
          <Users aria-hidden="true" />
          <span>{t("requestNotForYou")}</span>
        </div>
      )}

      {view.tally && (
        <div className="request-card__tally">
          {[
            ...view.tally,
            { label: t("requestNoAnswer"), count: view.waiting, none: true },
          ].map((row, index) => (
            <div
              key={index}
              className={cx(
                "request-tally",
                "none" in row && "request-tally--none",
              )}
            >
              <span className="request-tally__label truncate">{row.label}</span>
              <span className="request-tally__bar" aria-hidden="true">
                <i
                  style={{
                    inlineSize: `${view.total ? Math.min(100, (row.count / view.total) * 100) : 0}%`,
                  }}
                />
              </span>
              <strong className="tabular">{row.count}</strong>
            </div>
          ))}
        </div>
      )}

      <div className="request-card__foot">
        <span>
          {t("requestAnsweredOf", {
            answered: view.answered,
            total: view.total,
          })}
          {view.answer && view.canChange && view.changeUntil && (
            <>
              {" · "}
              {t("requestChangeUntil", { when: due(view.changeUntil) })}
            </>
          )}
          {view.edited && (
            <>
              {" · "}
              <span className="request-card__edited">{t("requestEdited")}</span>
            </>
          )}
        </span>
        {view.canViewAnswers && onOpenAnswers && (
          <button
            type="button"
            className="request-card__link request-card__link--strong"
            onClick={onOpenAnswers}
          >
            {t("requestMore")}
          </button>
        )}
      </div>

      {(view.remind.kind !== "hidden" || view.canClose) && (
        <div className="request-card__actions">
          {view.remind.kind === "ready" && (
            <Button
              size="sm"
              pending={actions.busy === "remind"}
              onClick={() => void actions.remind()}
            >
              <Bell aria-hidden="true" />
              {t("requestRemind", { count: view.remind.count })}
            </Button>
          )}
          {view.remind.kind === "cooldown" && (
            <span className="request-card__note">
              {t("requestRemindCooldown", { when: due(view.remind.until) })}
            </span>
          )}
          {view.remind.kind === "allAnswered" && (
            <span className="request-card__note request-card__note--ok">
              {t("requestAllAnswered")}
            </span>
          )}
          {view.canClose && view.open && (
            <Button
              size="sm"
              variant="ghost"
              pending={actions.busy === "close"}
              onClick={() => setConfirmClose(true)}
            >
              {t("requestClose")}
            </Button>
          )}
        </div>
      )}
      {view.autoRemindAt && view.role === "author" && (
        <div className="request-card__note">
          {t("requestAutoRemindAt", { when: due(view.autoRemindAt) })}
        </div>
      )}
      {confirmClose && (
        <ConfirmDialog
          title={t("requestCloseTitle")}
          description={t("requestCloseHint")}
          confirmLabel={t("requestClose")}
          pending={actions.busy === "close"}
          onConfirm={() =>
            void actions.close().then(() => setConfirmClose(false))
          }
          onClose={() => setConfirmClose(false)}
        />
      )}
    </div>
  );
}

export function RequestPill({
  view,
  due,
}: {
  view: Pick<RequestView, "pill">;
  due(at: Date): string;
}) {
  const { t } = useTranslation();
  const pill = view.pill;
  if (!pill) return null;
  if (pill.kind === "closed")
    return (
      <span
        className={cx(
          "request-pill",
          pill.warning && "request-pill--warning",
        )}
      >
        {t("requestClosed")}
      </span>
    );
  return (
    <span
      className={cx(
        "request-pill",
        "request-pill--warning",
        pill.overdue && "request-pill--overdue",
      )}
    >
      {t("requestDueBy", { when: due(pill.at) })}
    </span>
  );
}

export function RequestButtons({
  options,
  selected,
  disabled,
  onPick,
}: {
  options: string[];
  selected?: number;
  disabled?: boolean;
  onPick(option: number): void;
}) {
  if (options.length === 1)
    return (
      <button
        type="button"
        className="request-ack"
        disabled={disabled}
        aria-pressed={selected === 0 ? true : undefined}
        onClick={() => onPick(0)}
      >
        <Check aria-hidden="true" />
        {options[0]}
      </button>
    );
  return (
    <div className="request-buttons">
      {options.map((label, index) => (
        <button
          key={`${index}-${label}`}
          type="button"
          className={cx(
            "request-button",
            (selected === undefined ? index === 0 : selected === index) &&
              "request-button--primary",
          )}
          disabled={disabled}
          aria-pressed={selected === index ? true : undefined}
          onClick={() => onPick(index)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
