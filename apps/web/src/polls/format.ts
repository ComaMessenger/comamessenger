import {
  createAnonChoiceStore,
  pollErrorKind,
  type PollDraftProblem,
  type PollErrorKind,
} from "@comamessenger/core";
import i18n from "../i18n";

const pollFailKeys: Record<PollErrorKind, string> = {
  invalid: "pollFailInvalid",
  notMember: "pollFailNotMember",
  forbidden: "pollFailForbidden",
  gone: "pollFailGone",
  closed: "pollFailClosed",
  voteFinal: "pollFailVoteFinal",
  conflict: "pollFailConflict",
  limit: "pollFailLimit",
  archived: "pollFailArchived",
  remindTooSoon: "pollFailRemindTooSoon",
  rateLimited: "pollFailRateLimited",
  unavailable: "pollFailUnavailable",
  network: "pollFailNetwork",
  other: "pollFailOther",
};

/** Words for a refused poll call, for a toast or the form. */
export function pollErrorText(error: unknown): string {
  return i18n.t(pollFailKeys[pollErrorKind(error)]);
}

/** Why the form cannot be sent, in words. */
export function pollProblemText(problem: PollDraftProblem): string {
  switch (problem.field) {
    case "question":
      return i18n.t(
        problem.reason === "empty"
          ? "pollErrorQuestionEmpty"
          : "pollErrorQuestionTooLong",
      );
    case "options": {
      const index = (problem.index ?? 0) + 1;
      if (problem.reason === "tooFew") return i18n.t("pollErrorOptionsTooFew");
      if (problem.reason === "tooMany")
        return i18n.t("pollErrorOptionsTooMany");
      if (problem.reason === "tooLong")
        return i18n.t("pollErrorOptionTooLong", { index });
      return i18n.t("pollErrorOptionDuplicate", { index });
    }
    case "dueAt":
      return i18n.t(
        problem.reason === "past" ? "pollErrorDuePast" : "pollErrorDueTooFar",
      );
  }
}

/**
 * The reader's choice in anonymous polls, remembered on this device only:
 * the server never knows it (decision 5). localStorage may throw in a
 * private window; the store then keeps the mark until the tab closes.
 */
export const anonChoices = createAnonChoiceStore({
  getItem: (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: (key, value) => {
    localStorage.setItem(key, value);
  },
  removeItem: (key) => {
    localStorage.removeItem(key);
  },
});
