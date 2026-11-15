import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMember, Message } from "@comamessenger/core";
import i18n from "../i18n";
import { RequestDialog } from "./RequestDialog";

const self = "00000000-0000-4000-8000-000000000001";
const member = (n: number, name: string, type: "user" | "agent" = "user") =>
  ({
    actor_id: `00000000-0000-4000-8000-00000000000${n}`,
    display_name: name,
    handle: name.toLowerCase(),
    title: "",
    role: "member",
    joined_at: "2026-08-19T00:00:00Z",
    type,
  }) as ChatMember;
const members = [
  member(1, "Анна"),
  member(2, "Олег"),
  member(3, "Марина"),
  member(5, "Справка", "agent"),
];

function setup() {
  const createRequest = vi.fn(
    async (_chatID: string, input: { client_msg_id: string }) =>
      ({ id: "m1", client_msg_id: input.client_msg_id }) as unknown as Message,
  );
  const onSent = vi.fn();
  render(
    <RequestDialog
      chatID="c1"
      userID={self}
      members={members}
      createRequest={createRequest}
      onSent={onSent}
      onClose={() => undefined}
    />,
  );
  return { createRequest, onSent };
}

afterEach(cleanup);

describe("RequestDialog", () => {
  beforeEach(async () => {
    sessionStorage.clear();
    await i18n.changeLanguage("ru");
  });

  it("asks the whole chat but the author and agents by default", () => {
    setup();
    expect(screen.getByText(/Ждём от 2 человек/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Отправить запрос · 2 людям" }),
    ).toBeInTheDocument();
  });

  it("checks the form in the order of its fields", async () => {
    const { createRequest } = setup();
    const send = () =>
      fireEvent.click(screen.getByRole("button", { name: /Отправить запрос/ }));
    send();
    expect(screen.getByText("Напишите, о чём просите ответить")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Вопрос" }), {
      target: { value: "Кто дежурит?" },
    });
    fireEvent.click(screen.getByRole("radio", { name: "Люди" }));
    expect(screen.getByText("Выберите, от кого ждёте ответа")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Марина" }));
    fireEvent.click(screen.getByRole("radio", { name: "Свои кнопки" }));
    expect(screen.getByText("Нужно хотя бы две кнопки")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Кнопка 1" }), {
      target: { value: "Я" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Кнопка 2" }), {
      target: { value: "я" },
    });
    expect(screen.getByText("Кнопка 2 повторяет другую")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Кнопка 2" }), {
      target: { value: "Не я" },
    });
    expect(createRequest).not.toHaveBeenCalled();
    send();
    await waitFor(() => expect(createRequest).toHaveBeenCalledTimes(1));
    expect(createRequest.mock.calls[0]![1]).toMatchObject({
      body: "Кто дежурит?",
      audience: { kind: "people", actor_ids: [members[2]!.actor_id] },
      answer: { preset: "custom", options: ["Я", "Не я"] },
      allow_comment: true,
      auto_remind: false,
    });
  });

  it("retries a failed send with the same client id", async () => {
    const { createRequest, onSent } = setup();
    createRequest.mockRejectedValueOnce(new Error("offline"));
    fireEvent.change(screen.getByRole("textbox", { name: "Вопрос" }), {
      target: { value: "Ознакомьтесь с графиком" },
    });
    const send = screen.getByRole("button", { name: /Отправить запрос/ });
    fireEvent.click(send);
    expect(
      await screen.findByText("Нет связи. Попробуйте ещё раз"),
    ).toBeInTheDocument();
    fireEvent.click(send);
    await waitFor(() => expect(onSent).toHaveBeenCalled());
    const [first, second] = createRequest.mock.calls.map(
      (call) => call[1].client_msg_id,
    );
    expect(first).toBe(second);
  });
});
