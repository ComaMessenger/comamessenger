import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, MessagePoll, PollViewer } from "@comamessenger/core";
import i18n from "../i18n";
import { PollCard, type PollCardActions } from "./PollCard";

const self = "00000000-0000-4000-8000-000000000001";
const author = "00000000-0000-4000-8000-000000000003";
// Wednesday 11 November 2026, 10:15 local time.
const now = new Date(2026, 10, 11, 10, 15);
const friday = new Date(2026, 10, 13, 18, 0).toISOString();

function poll(patch: Partial<MessagePoll> = {}): MessagePoll {
  return {
    question: "Какой день удобнее?",
    options: ["Вторник", "Среда", "Четверг"],
    multiple: false,
    anonymous: false,
    due_at: friday,
    status: "open",
    closed_reason: null,
    closed_at: null,
    voter_count: 2,
    member_count: 4,
    final_counts: null,
    version: 3,
    ...patch,
  };
}

function viewer(patch: Partial<PollViewer> = {}): PollViewer {
  return {
    voted: false,
    my_options: null,
    can_vote: true,
    can_change: false,
    can_view_results: false,
    can_view_voters: false,
    can_view_waiting: false,
    can_close: false,
    can_remind: false,
    next_remind_at: null,
    counts: null,
    ...patch,
  };
}

const message = (
  value: MessagePoll,
  patch: Partial<Message> = {},
): Pick<Message, "id" | "actor_id" | "edited_at" | "poll"> => ({
  id: "00000000-0000-4000-8000-000000000701",
  actor_id: author,
  poll: value,
  ...patch,
});

function actions(): PollCardActions {
  return {
    vote: vi.fn(async () => true),
    retract: vi.fn(async () => true),
    close: vi.fn(async () => true),
    remind: vi.fn(async () => true),
    busy: null,
  };
}

afterEach(cleanup);
beforeEach(async () => {
  await i18n.changeLanguage("ru");
});

describe("PollCard", () => {
  it("before the vote shows circles and N of M, never the counts", () => {
    const handlers = actions();
    render(
      <PollCard
        message={message(poll())}
        viewer={viewer()}
        selfID={self}
        actions={handlers}
        now={now}
      />,
    );
    expect(screen.getByText("до пт, 18:00")).toBeInTheDocument();
    expect(screen.getByText("2 из 4 ответили")).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(document.body.textContent).not.toMatch(/%/);
    expect(screen.queryByText("Кто голосовал")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Среда" }));
    expect(handlers.vote).toHaveBeenCalledWith([1]);
  });

  it("after the vote shows the bars, the reader's mark and retract", () => {
    const handlers = actions();
    render(
      <PollCard
        message={message(poll({ voter_count: 3 }))}
        viewer={viewer({
          voted: true,
          my_options: [1],
          can_change: true,
          can_view_results: true,
          can_view_voters: true,
          counts: [1, 2, 0],
        })}
        selfID={self}
        actions={handlers}
        onOpenVoters={() => undefined}
        now={now}
      />,
    );
    expect(screen.getByRole("radio", { name: "Среда: 67 %" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("img", { name: "Ваш выбор" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Отменить голос" }));
    expect(handlers.retract).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Кто голосовал" })).toBeInTheDocument();
    // A tap on another option changes the vote.
    fireEvent.click(screen.getByRole("radio", { name: "Четверг: 0 %" }));
    expect(handlers.vote).toHaveBeenCalledWith([2]);
  });

  it("several answers before the first vote: tick, then «Голосовать»", () => {
    const handlers = actions();
    render(
      <PollCard
        message={message(poll({ multiple: true }))}
        viewer={viewer()}
        selfID={self}
        actions={handlers}
        now={now}
      />,
    );
    expect(screen.getByText("Опрос · несколько ответов")).toBeInTheDocument();
    const vote = screen.getByRole("button", { name: "Голосовать" });
    expect(vote).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Четверг" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Вторник" }));
    expect(handlers.vote).not.toHaveBeenCalled();
    fireEvent.click(vote);
    expect(handlers.vote).toHaveBeenCalledWith([0, 2]);
  });

  it("anonymous: warns before, no retract and no names after", () => {
    const { rerender } = render(
      <PollCard
        message={message(poll({ anonymous: true }))}
        viewer={viewer()}
        selfID={self}
        actions={actions()}
        now={now}
      />,
    );
    expect(screen.getByText("Анонимный опрос")).toBeInTheDocument();
    expect(
      screen.getByText("Анонимно · голос нельзя изменить"),
    ).toBeInTheDocument();
    rerender(
      <PollCard
        message={message(poll({ anonymous: true, voter_count: 3 }))}
        viewer={viewer({
          voted: true,
          can_vote: false,
          can_view_results: true,
          counts: [1, 2, 0],
        })}
        selfID={self}
        actions={actions()}
        anonChoice={[1]}
        onOpenVoters={() => undefined}
        now={now}
      />,
    );
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Среда: 67 %" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Ваш выбор" })).toBeInTheDocument();
    expect(screen.queryByText("Отменить голос")).not.toBeInTheDocument();
    expect(screen.queryByText("Кто голосовал")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Анонимно · голос нельзя изменить"),
    ).not.toBeInTheDocument();
  });

  it("another device of the anonymous voter says «Вы проголосовали»", () => {
    render(
      <PollCard
        message={message(poll({ anonymous: true, voter_count: 3 }))}
        viewer={viewer({
          voted: true,
          can_vote: false,
          can_view_results: true,
          counts: [1, 2, 0],
        })}
        selfID={self}
        actions={actions()}
        now={now}
      />,
    );
    expect(screen.getByText("Вы проголосовали")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Ваш выбор" })).not.toBeInTheDocument();
  });

  it("closed: the result for everyone, the winner, no voting", () => {
    render(
      <PollCard
        message={message(
          poll({
            status: "closed",
            closed_reason: "author",
            closed_at: now.toISOString(),
            voter_count: 3,
            final_counts: [1, 2, 0],
          }),
        )}
        viewer={viewer({ can_vote: false })}
        selfID={self}
        actions={actions()}
        now={now}
      />,
    );
    expect(screen.getByText("Закрыт")).toBeInTheDocument();
    expect(screen.getByText("Итог: «Среда» — 2 из 3")).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(
      document.querySelector(".poll-option--winner")?.textContent,
    ).toContain("Среда");
  });

  it("the author sees results always, reminds and closes after confirming", async () => {
    const handlers = actions();
    render(
      <PollCard
        message={message(poll(), { actor_id: self, edited_at: now.toISOString() })}
        viewer={viewer({
          can_view_results: true,
          can_view_voters: true,
          can_view_waiting: true,
          can_close: true,
          can_remind: true,
          counts: [1, 1, 0],
        })}
        selfID={self}
        actions={handlers}
        onOpenVoters={() => undefined}
        now={now}
      />,
    );
    expect(screen.getByRole("radio", { name: "Вторник: 50 %" })).toBeInTheDocument();
    expect(screen.getByText("изм.")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Напомнить не ответившим · 2" }),
    );
    expect(handlers.remind).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    const confirm = await screen.findByRole("dialog", { name: "Закрыть опрос?" });
    expect(handlers.close).not.toHaveBeenCalled();
    fireEvent.click(
      Array.from(confirm.querySelectorAll("button")).find(
        (button) => button.textContent === "Закрыть",
      )!,
    );
    expect(handlers.close).toHaveBeenCalled();
  });

  it("a cooldown after the reminder and «Все ответили»", () => {
    const { rerender } = render(
      <PollCard
        message={message(poll(), { actor_id: self })}
        viewer={viewer({
          can_view_results: true,
          counts: [1, 1, 0],
          next_remind_at: new Date(2026, 10, 11, 12, 15).toISOString(),
        })}
        selfID={self}
        actions={actions()}
        now={now}
      />,
    );
    expect(screen.getByText("Напомнили · повторно сегодня, 12:15")).toBeInTheDocument();
    rerender(
      <PollCard
        message={message(poll({ voter_count: 4 }), { actor_id: self })}
        viewer={viewer({ can_view_results: true, counts: [2, 2, 0] })}
        selfID={self}
        actions={actions()}
        now={now}
      />,
    );
    expect(screen.getByText("Все ответили")).toBeInTheDocument();
  });
});
