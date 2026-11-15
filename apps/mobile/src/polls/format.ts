import {
  createAnonChoiceStore,
  pollErrorKind,
  type PollDraftProblem,
  type PollErrorKind,
} from "@comamessenger/core";
import { accountValues } from "@/lib/database";

type Translate = (key: string, values?: Record<string, unknown>) => string;

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

/** Words for a refused poll call, for a notice or the form. */
export function pollErrorText(t: Translate, error: unknown): string {
  return t(pollFailKeys[pollErrorKind(error)]);
}

/** Why the form cannot be sent, in words. */
export function pollProblemText(
  t: Translate,
  problem: PollDraftProblem,
): string {
  switch (problem.field) {
    case "question":
      return t(
        problem.reason === "empty"
          ? "pollErrorQuestionEmpty"
          : "pollErrorQuestionTooLong",
      );
    case "options": {
      const index = (problem.index ?? 0) + 1;
      if (problem.reason === "tooFew") return t("pollErrorOptionsTooFew");
      if (problem.reason === "tooMany") return t("pollErrorOptionsTooMany");
      if (problem.reason === "tooLong")
        return t("pollErrorOptionTooLong", { index });
      return t("pollErrorOptionDuplicate", { index });
    }
    case "dueAt":
      return t(
        problem.reason === "past" ? "pollErrorDuePast" : "pollErrorDueTooFar",
      );
  }
}

/**
 * The reader's choice in anonymous polls, remembered on this device only
 * (decision 5): the server never knows it. Kept with the account's values,
 * so it goes away on sign-out with the rest of the account's data.
 */
export const anonChoices = createAnonChoiceStore({
  getItem: async (key) => {
    const value = await accountValues.get<number[]>(key);
    return value ? JSON.stringify(value) : null;
  },
  setItem: (key, value) => accountValues.set(key, JSON.parse(value)),
  removeItem: (key) => accountValues.set(key, null),
});
