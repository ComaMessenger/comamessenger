import { useEffect, useRef, useState, type ReactNode } from "react";
import { BarChartHorizontal, Bell, Check, Trophy } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  formatPollDue,
  pollAnsweredText,
  pollView,
  togglePollChoice,
  type ChatMember,
  type Message,
  type PollView,
  type PollViewer,
} from "@comamessenger/core";
import { Avatar, AvatarStack, Button, cx } from "../ui";
import { ConfirmDialog } from "../dialogs/ConfirmDialog";
import { calendarLocale } from "../requests/format";
import type { PollBusy } from "./usePoll";

export type PollCardActions = {
  vote(options: number[]): Promise<boolean>;
  retract(): Promise<boolean>;
  close(): Promise<boolean>;
  remind(): Promise<boolean>;
  busy: PollBusy;
};

/**
 * The poll in the feed. Before the reader's vote: circles (squares with
 * several answers) and "N of M voted", never the counts. After the vote,
 * for the author always and for everyone once closed: bars, percentages, the
 * reader's check mark and, in an ordinary poll, who chose what. Pure: the
 * row passes the viewer, the actions and the voters' faces.
 */
export function PollCard({
  message,
  viewer,
  selfID,
  actions,
  anonChoice = null,
  optionVoters,
  members = [],
  onOpenVoters,
  votersAnchor,
  now = new Date(),
}: {
  message: Pick<Message, "id" | "actor_id" | "edited_at" | "poll">;
  viewer: PollViewer | null;
  selfID: string;
  actions: PollCardActions;
  /** The reader's choice in an anonymous poll as this device remembers it. */
  anonChoice?: readonly number[] | null;
  /** First voters of each option, for the faces next to it (ordinary polls). */
  optionVoters?: Readonly<Record<number, readonly string[]>>;
  members?: readonly ChatMember[];
  /** Who voted. */
  onOpenVoters?(): void;
  /** The Who voted button, for a popover to attach to. */
  votersAnchor?: React.RefObject<HTMLButtonElement | null>;
  now?: Date;
}) {
  const { t } = useTranslation();
  const locale = calendarLocale();
  const view = pollView(message, viewer, {
    selfID,
    now,
    locale,
    anonChoice,
  });
  const [selection, setSelection] = useState<number[]>([]);
  const [confirmClose, setConfirmClose] = useState(false);
  const mine = view?.options.filter((o) => o.chosen).map((o) => o.index) ?? [];
  const mineKey = mine.join(",");
  // A vote from another device replaces what was ticked here.
  const lastMine = useRef(mineKey);
  useEffect(() => {
    if (lastMine.current === mineKey) return;
    lastMine.current = mineKey;
    setSelection([]);
  }, [mineKey]);
  if (!view) return null;
  const due = (at: Date) => formatPollDue(at, now, locale);
  const busy = actions.busy !== null;

  async function tap(index: number) {
    if (!view || busy) return;
    if (view.voteMode === "select") {
      setSelection((current) => togglePollChoice(current, index, true));
      return;
    }
    if (view.voteMode !== "instant") return;
    if (!view.multiple) {
      if (view.voted && mine.length === 1 && mine[0] === index) return;
      await actions.vote([index]);
      return;
    }
    // Several answers after the first vote: each tap changes the vote, and
    // the last option unticked takes the vote back.
    const next = togglePollChoice(mine, index, true);
    if (next.length) await actions.vote(next);
    else await actions.retract();
  }

  const label = view.anonymous ? t("pollCardLabelAnonymous") : t("pollCardLabel");
  const selecting = view.voteMode === "select";
  const interactive = view.voteMode !== "none";

  return (
    <div
      className={cx(
        "poll-card",
        !view.open && "poll-card--closed",
        view.showResults && "poll-card--results",
      )}
      data-poll-id={message.id}
    >
      <div className="poll-card__head">
        <BarChartHorizontal aria-hidden="true" />
        <span>
          {label}
          {view.multiple && ` · ${t("pollCardMultiple")}`}
        </span>
        <PollPill view={view} due={due} />
      </div>
      <div className="poll-card__question">{view.question}</div>

      <div
        className="poll-card__options"
        role={interactive ? "group" : undefined}
        aria-label={view.question}
      >
        {view.options.map((option) => {
          const ticked = selecting
            ? selection.includes(option.index)
            : option.chosen;
          const faces = optionVoters?.[option.index] ?? [];
          const content: ReactNode = (
            <>
              <span
                className="poll-option__fill"
                aria-hidden="true"
                style={{
                  inlineSize: `${view.showResults ? (option.percent ?? 0) : 0}%`,
                }}
              />
              {(!view.showResults || selecting) && (
                <span
                  className={cx(
                    "poll-option__mark",
                    view.input === "checkbox" && "poll-option__mark--square",
                  )}
                  aria-hidden="true"
                >
                  {ticked && <Check />}
                </span>
              )}
              <span className="poll-option__label">{option.label}</span>
              {view.showResults && (
                <>
                  {option.winner && (
                    <Trophy className="poll-option__winner" aria-hidden="true" />
                  )}
                  {option.chosen && (
                    <Check
                      className="poll-option__mine"
                      role="img"
                      aria-label={t("pollMine")}
                    />
                  )}
                  {!view.anonymous && faces.length > 0 && (
                    <span className="poll-option__faces" aria-hidden="true">
                      <AvatarStack>
                        {faces.slice(0, 3).map((id) => {
                          const member = members.find((m) => m.actor_id === id);
                          return (
                            <Avatar
                              key={id}
                              name={member?.display_name ?? ""}
                              seed={id}
                              actorID={id}
                              avatarVersion={member?.avatar_version}
                              size="xs"
                            />
                          );
                        })}
                      </AvatarStack>
                    </span>
                  )}
                  <strong className="poll-option__percent tabular">
                    {option.percent === null ? "" : `${option.percent}%`}
                  </strong>
                </>
              )}
            </>
          );
          const className = cx(
            "poll-option",
            ticked && "poll-option--chosen",
            option.winner && "poll-option--winner",
            view.showResults && "poll-option--result",
          );
          const accessible =
            view.showResults && option.percent !== null
              ? t("pollOptionResult", {
                  label: option.label,
                  percent: option.percent,
                })
              : option.label;
          return interactive ? (
            <button
              key={option.index}
              type="button"
              className={className}
              role={view.input}
              aria-checked={ticked}
              aria-label={accessible}
              disabled={busy}
              onClick={() => void tap(option.index)}
            >
              {content}
            </button>
          ) : (
            <div
              key={option.index}
              className={className}
              aria-label={accessible}
              role="img"
            >
              {content}
            </div>
          );
        })}
      </div>

      {selecting && (
        <Button
          size="sm"
          variant="primary"
          className="poll-card__vote"
          disabled={!selection.length}
          pending={actions.busy === "vote"}
          onClick={() =>
            void actions.vote(selection).then((done) => {
              if (done) setSelection([]);
            })
          }
        >
          {t("pollVote")}
        </Button>
      )}
      {view.finalVoteHint && (
        <div className="poll-card__note">{t("pollFinalHint")}</div>
      )}
      {view.anonymous && view.voted && !mine.length && view.open && (
        <div className="poll-card__note">{t("pollYouVoted")}</div>
      )}
      {view.resultsLoading && (
        <div className="poll-card__note">{t("pollResultsLoading")}</div>
      )}
      {view.result && (
        <div className="poll-card__result">
          <Check aria-hidden="true" />
          <span>{view.result}</span>
        </div>
      )}

      <div className="poll-card__foot">
        <span>
          {pollAnsweredText(view.voterCount, view.memberCount, locale)}
          {view.edited && (
            <>
              {" · "}
              <span className="poll-card__edited">{t("pollEdited")}</span>
            </>
          )}
        </span>
        <span className="poll-card__links">
          {view.canRetract && (
            <button
              type="button"
              className="poll-card__link"
              disabled={busy}
              onClick={() => void actions.retract()}
            >
              {t("pollRetract")}
            </button>
          )}
          {(view.canViewVoters || view.canViewWaiting) &&
            view.showResults &&
            onOpenVoters && (
              <button
                ref={votersAnchor}
                type="button"
                className="poll-card__link"
                onClick={onOpenVoters}
              >
                {t("pollWhoVoted")}
              </button>
            )}
          {view.canClose && (
            <button
              type="button"
              className="poll-card__link"
              disabled={busy}
              onClick={() => setConfirmClose(true)}
            >
              {t("pollClose")}
            </button>
          )}
        </span>
      </div>

      {view.remind.kind !== "hidden" && (
        <div className="poll-card__actions">
          {view.remind.kind === "ready" && (
            <Button
              size="sm"
              pending={actions.busy === "remind"}
              onClick={() => void actions.remind()}
            >
              <Bell aria-hidden="true" />
              {t("pollRemind", { count: view.remind.count })}
            </Button>
          )}
          {view.remind.kind === "cooldown" && (
            <span className="poll-card__note">
              {t("pollRemindCooldown", { when: due(view.remind.until) })}
            </span>
          )}
          {view.remind.kind === "allAnswered" && (
            <span className="poll-card__note poll-card__note--ok">
              {t("pollAllAnswered")}
            </span>
          )}
        </div>
      )}
      {confirmClose && (
        <ConfirmDialog
          title={t("pollCloseTitle")}
          description={t("pollCloseHint")}
          confirmLabel={t("pollClose")}
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

function PollPill({
  view,
  due,
}: {
  view: Pick<PollView, "pill">;
  due(at: Date): string;
}) {
  const { t } = useTranslation();
  const pill = view.pill;
  if (!pill) return null;
  if (pill.kind === "closed")
    return <span className="request-pill">{t("pollClosed")}</span>;
  return (
    <span
      className={cx(
        "request-pill",
        "request-pill--warning",
        pill.overdue && "request-pill--overdue",
      )}
    >
      {t("pollDueBy", { when: due(pill.at) })}
    </span>
  );
}
