import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@comamessenger/core";
import i18n from "../i18n";
import { PollDialog } from "./PollDialog";

const self = "00000000-0000-4000-8000-000000000001";

function setup(createPoll = vi.fn(
  async (_chatID: string, input: { client_msg_id: string }) =>
    ({ id: "m1", client_msg_id: input.client_msg_id }) as unknown as Message,
)) {
  const onSent = vi.fn();
  const view = render(
    <PollDialog
      chatID="c1"
      userID={self}
      createPoll={createPoll}
      onSent={onSent}
      onClose={() => undefined}
    />,
  );
  return { createPoll, onSent, view };
}

const field = (label: string) =>
  screen.getByLabelText(label, { exact: true }) as HTMLInputElement;

afterEach(cleanup);

describe("PollDialog", () => {
  beforeEach(async () => {
    sessionStorage.clear();
    await i18n.changeLanguage("ru");
  });

  it("sends the question, the filled options and the flags", async () => {
    const { createPoll, onSent } = setup();
    fireEvent.change(field("Вопрос"), { target: { value: "  Когда субботник?  " } });
    fireEvent.change(field("Вариант 1"), { target: { value: "Суббота" } });
    fireEvent.change(field("Вариант 2"), { target: { value: "Воскресенье" } });
    fireEvent.click(screen.getByRole("button", { name: "Добавить вариант" }));
    expect(field("Вариант 3")).toHaveValue("");
    fireEvent.click(screen.getByRole("switch", { name: "Анонимно" }));
    fireEvent.click(screen.getByRole("button", { name: "Отправить опрос" }));
    await waitFor(() => expect(onSent).toHaveBeenCalled());
    expect(createPoll.mock.calls[0]![0]).toBe("c1");
    expect(createPoll.mock.calls[0]![1]).toMatchObject({
      question: "Когда субботник?",
      options: ["Суббота", "Воскресенье"],
      multiple: false,
      anonymous: true,
    });
    expect(createPoll.mock.calls[0]![1]).not.toHaveProperty("due_at");
    // Sent: the draft is gone.
    expect(sessionStorage.length).toBe(0);
  });

  it("names the first problem: an empty question, a repeated option", () => {
    const { createPoll } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Отправить опрос" }));
    expect(screen.getByText("Напишите вопрос")).toBeInTheDocument();
    fireEvent.change(field("Вопрос"), { target: { value: "Чай или кофе?" } });
    fireEvent.change(field("Вариант 1"), { target: { value: "Чай" } });
    fireEvent.change(field("Вариант 2"), { target: { value: "ЧАЙ" } });
    expect(screen.getByText("Вариант 2 повторяет другой")).toBeInTheDocument();
    expect(field("Вариант 2")).toHaveAttribute("aria-invalid", "true");
    expect(createPoll).not.toHaveBeenCalled();
  });

  it("removes an option only above two and moves one with the arrows", () => {
    setup();
    expect(screen.queryByRole("button", { name: "Убрать вариант 1" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Добавить вариант" }));
    fireEvent.change(field("Вариант 1"), { target: { value: "А" } });
    fireEvent.change(field("Вариант 3"), { target: { value: "В" } });
    fireEvent.keyDown(
      screen.getByRole("button", { name: /Переставить вариант 3/ }),
      { key: "ArrowUp" },
    );
    expect(field("Вариант 2")).toHaveValue("В");
    fireEvent.click(screen.getByRole("button", { name: "Убрать вариант 1" }));
    expect(field("Вариант 1")).toHaveValue("В");
    expect(screen.queryByLabelText("Вариант 3", { exact: true })).toBeNull();
  });

  it("offers the due chips and a date of one's own", () => {
    const { createPoll } = setup();
    expect(screen.getByRole("radio", { name: "Без срока" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    fireEvent.click(screen.getByRole("radio", { name: "Другая дата" }));
    expect(screen.getByLabelText("Дата и время")).toBeInTheDocument();
    expect(createPoll).not.toHaveBeenCalled();
  });

  it("keeps the draft and retries with the same id", async () => {
    const createPoll = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ id: "m1" } as Message);
    const { view } = setup(createPoll);
    fireEvent.change(field("Вопрос"), { target: { value: "Планёрка?" } });
    fireEvent.change(field("Вариант 1"), { target: { value: "Да" } });
    fireEvent.change(field("Вариант 2"), { target: { value: "Нет" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить опрос" }));
    await waitFor(() => expect(createPoll).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Отправить опрос" }));
    await waitFor(() => expect(createPoll).toHaveBeenCalledTimes(2));
    expect(createPoll.mock.calls[1]![1].client_msg_id).toBe(
      createPoll.mock.calls[0]![1].client_msg_id,
    );
    view.unmount();
  });

  it("opens with the draft kept for the session", () => {
    sessionStorage.setItem(
      `coma-poll-draft:${self}:c1`,
      JSON.stringify({
        draft: JSON.stringify({
          question: "Субботник?",
          options: ["Да", "Нет", ""],
          multiple: true,
          anonymous: false,
          dueAt: null,
        }),
        due: "none",
        customDue: "",
      }),
    );
    setup();
    expect(field("Вопрос")).toHaveValue("Субботник?");
    expect(field("Вариант 3")).toHaveValue("");
    expect(screen.getByRole("switch", { name: "Несколько ответов" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });
});
