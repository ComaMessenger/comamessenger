import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Message,
  MessageRequest,
  MessageRequestViewer,
} from "@comamessenger/core";
import i18n from "../i18n";
import { RequestCard, type RequestCardActions } from "./RequestCard";

const self = "00000000-0000-4000-8000-000000000001";
const author = "00000000-0000-4000-8000-000000000003";
// Wednesday 11 November 2026, 10:15 local time.
const now = new Date(2026, 10, 11, 10, 15);
const friday = new Date(2026, 10, 13, 18, 0).toISOString();

function request(patch: Partial<MessageRequest> = {}): MessageRequest {
  return {
    status: "open",
    closed_reason: null,
    answer: { preset: "attend" },
    allow_comment: true,
    due_at: friday,
    auto_remind_at: null,
    audience: { kind: "chat", label: "", count: 4 },
    answered_count: 1,
    waiting_count: 3,
    version: 2,
    ...patch,
  };
}

function viewer(patch: Partial<MessageRequestViewer> = {}): MessageRequestViewer {
  return {
    role: "recipient",
    answer: null,
    can_answer: true,
    can_change: false,
    can_view_answers: false,
    can_close: false,
    can_remind: false,
    next_remind_at: null,
    tally: null,
    ...patch,
  };
}

function message(
  value: MessageRequest,
  patch: Partial<Message> = {},
): Pick<Message, "id" | "actor_id" | "edited_at" | "request" | "body"> {
  return {
    id: "00000000-0000-4000-8000-000000000031",
    actor_id: author,
    body: "Планёрка в понедельник в 8:30. Будете?",
    request: value,
    ...patch,
  };
}

function actions(): RequestCardActions {
  return {
    answer: vi.fn(async () => true),
    close: vi.fn(async () => true),
    remind: vi.fn(async () => true),
    busy: null,
  };
}

async function ru() {
  await i18n.changeLanguage("ru");
}

afterEach(cleanup);

describe("RequestCard", () => {
  it("gives a recipient the buttons and sends the tapped option", async () => {
    await ru();
    const handlers = actions();
    render(
      <RequestCard
        message={message(request())}
        viewer={viewer()}
        selfID={self}
        actions={handlers}
        now={now}
      />,
    );
    expect(screen.getByText("до пт, 18:00")).toBeInTheDocument();
    expect(screen.getByText("ждём ответа: весь чат · 4")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Не приду" }));
    expect(handlers.answer).toHaveBeenCalledWith(1);
    expect(screen.getByText("Ответили 1 из 4")).toBeInTheDocument();
  });

  it("shows one big button for «Ознакомлен(а)»", async () => {
    await ru();
    render(
      <RequestCard
        message={message(request({ answer: { preset: "ack" } }))}
        viewer={viewer()}
        selfID={self}
        actions={actions()}
        now={now}
      />,
    );
    expect(screen.getByRole("button", { name: "Ознакомлен(а)" })).toHaveClass(
      "request-ack",
    );
  });

  it("shows the answer, «после срока», the comment and «изм.»", async () => {
    await ru();
    render(
      <RequestCard
        message={message(request(), { edited_at: "2026-11-11T07:00:00Z" })}
        viewer={viewer({
          answer: {
            option: 0,
            comment: "буду к 8:20",
            answered_at: "2026-11-11T07:00:00Z",
            late: true,
            version: 2,
          },
          can_change: true,
        })}
        selfID={self}
        actions={actions()}
        now={now}
      />,
    );
    expect(screen.getByText(/Ваш ответ: Приду/)).toHaveTextContent(
      "Ваш ответ: Приду · после срока",
    );
    expect(screen.getByText("буду к 8:20")).toBeInTheDocument();
    expect(screen.getByText("изм.")).toBeInTheDocument();
    expect(screen.getByText(/изменить можно до пт, 18:00/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Приду" })).toBeNull();
  });

  it("tells the others that their answer is not expected", async () => {
    await ru();
    render(
      <RequestCard
        message={message(request())}
        viewer={viewer({ role: "observer", can_answer: false })}
        selfID={self}
        actions={actions()}
        now={now}
      />,
    );
    expect(
      screen.getByText("Ответа ждут не от вас — кнопок нет"),
    ).toBeInTheDocument();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("gives the author the bars, «Напомнить» and «Подробнее»", async () => {
    await ru();
    const handlers = actions();
    const open = vi.fn();
    render(
      <RequestCard
        message={message(request(), { actor_id: self })}
        viewer={viewer({
          role: "author",
          can_answer: false,
          can_view_answers: true,
          can_close: true,
          can_remind: true,
          tally: [1, 0],
        })}
        selfID={self}
        actions={handlers}
        onOpenAnswers={open}
        now={now}
      />,
    );
    expect(screen.getByText("Нет ответа")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Напомнить · 3" }));
    expect(handlers.remind).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Подробнее" }));
    expect(open).toHaveBeenCalled();
  });

  it("marks a closed request and an overdue one", async () => {
    await ru();
    const { rerender } = render(
      <RequestCard
        message={message(request({ status: "closed", closed_reason: "author" }))}
        viewer={viewer({ can_answer: false })}
        selfID={self}
        actions={actions()}
        now={now}
      />,
    );
    expect(screen.getByText("Закрыт")).toHaveClass("request-pill");
    expect(screen.queryByRole("button", { name: "Приду" })).toBeNull();
    rerender(
      <RequestCard
        message={message(
          request({ due_at: new Date(2026, 10, 11, 9, 0).toISOString() }),
        )}
        viewer={viewer()}
        selfID={self}
        actions={actions()}
        now={now}
      />,
    );
    expect(screen.getByText(/^до сегодня, 0?9:00$/)).toHaveClass(
      "request-pill--overdue",
    );
  });
});
