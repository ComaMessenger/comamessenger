import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMessengerStore,
  type AwayPublic,
  type AwayStatus,
  type ChatMember,
  type MessengerAPI,
  type User,
} from "@comamessenger/core";
import i18n from "../i18n";
import {
  MessengerContext,
  type MessengerContextValue,
} from "../shell/MessengerContext";
import { ToastProvider } from "../shell/ToastProvider";
import { StatusDialog } from "../dialogs/StatusDialog";
import { Composer } from "../composer/Composer";
import { useAwayMentionHints } from "./AwayMentions";

const me = "00000000-0000-4000-8000-000000000001";
const oleg = "00000000-0000-4000-8000-000000000002";
const marina = "00000000-0000-4000-8000-000000000003";

const person = (actorID: string, name: string, handle: string, away?: AwayPublic | null) =>
  ({
    actor_id: actorID,
    display_name: name,
    handle,
    title: "Инструктор",
    type: "user",
    role: "member",
    joined_at: "2026-08-19T00:00:00Z",
    avatar_version: 0,
    away: away ?? null,
  }) as unknown as ChatMember;

const vacation = (): AwayPublic => ({
  kind: "vacation",
  label: "",
  starts_at: new Date(Date.now() - 86_400_000).toISOString(),
  ends_at: new Date(Date.now() + 5 * 86_400_000).toISOString(),
  active: true,
  substitute_id: marina,
  notifications_off: true,
});

function harness(options: {
  features: string[];
  away?: AwayStatus | null;
  user?: Partial<User>;
}) {
  const store = createMessengerStore();
  store.getState().setFeatures(options.features);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const api = {
    away: vi.fn(async () => options.away ?? null),
    setAway: vi.fn(async (input: unknown) => ({
      ...(input as object),
      version: 1,
    })),
    clearAway: vi.fn(async () => undefined),
    setStatus: vi.fn(async (_input: unknown) => undefined),
    clearStatus: vi.fn(async () => undefined),
    me: vi.fn(async () => ({ id: me })),
    actors: vi.fn(async () => ({
      actors: [
        person(me, "Анна Иванова", "anna"),
        person(oleg, "Олег Чернов", "oleg"),
        person(marina, "Марина Соколова", "marina"),
      ],
      next_after_id: null,
    })),
    substituting: vi.fn(async () => []),
  };
  const value = {
    api: api as unknown as MessengerAPI,
    user: {
      id: me,
      display_name: "Анна Иванова",
      handle: "anna",
      permissions: [],
      status_emoji: "",
      status_text: "",
      away: null,
      ...options.user,
    } as unknown as User,
    store,
    navigate: vi.fn(),
    onUserUpdated: vi.fn(),
    scheduleReload: vi.fn(),
  } as unknown as MessengerContextValue;
  const wrap = (node: React.ReactNode) =>
    render(
      <QueryClientProvider client={client}>
        <MessengerContext.Provider value={value}>
          <ToastProvider>{node}</ToastProvider>
        </MessengerContext.Provider>
      </QueryClientProvider>,
    );
  return { api, value, wrap, store };
}

afterEach(cleanup);
beforeEach(async () => {
  await i18n.changeLanguage("ru");
});

describe("StatusDialog", () => {
  it("offers only the custom status before the server has actor_away", async () => {
    const { api, wrap } = harness({ features: [] });
    const onClose = vi.fn();
    wrap(<StatusDialog onClose={onClose} />);
    expect(screen.queryByRole("radio", { name: "Отсутствую" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Текст статуса"), {
      target: { value: "На встрече" },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(api.setStatus).toHaveBeenCalled());
    expect(api.setStatus.mock.calls[0]![0]).toMatchObject({
      text: "На встрече",
      expires_at: null,
    });
    expect(api.away).not.toHaveBeenCalled();
  });

  it("sets a trip with the default auto-reply naming the substitute", async () => {
    const { api, wrap } = harness({ features: ["actor_away"] });
    const onClose = vi.fn();
    wrap(<StatusDialog onClose={onClose} />);
    const trip = await screen.findByRole("radio", { name: /На выезде/ });
    fireEvent.click(trip);
    fireEvent.click(screen.getByRole("button", { name: /Выбрать…/ }));
    fireEvent.click(
      await screen.findByRole("option", { name: /Марина Соколова/ }),
    );
    const text = screen.getByLabelText("Текст автоответа") as HTMLTextAreaElement;
    await waitFor(() =>
      expect(text.value).toContain("По срочным вопросам — к Марине Соколовой"),
    );
    expect(text.value).toMatch(/^Я на выезде до /);
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(api.setAway).toHaveBeenCalled());
    expect(api.setAway.mock.calls[0]![0]).toMatchObject({
      kind: "trip",
      substitute_id: marina,
      mute_push: false,
      autoreply: { enabled: true },
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("refuses an «Другое» without its text", async () => {
    const { api, wrap } = harness({ features: ["actor_away"] });
    wrap(<StatusDialog onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("radio", { name: /Другое/ }));
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Напишите, где вы")).toBeInTheDocument();
    expect(api.setAway).not.toHaveBeenCalled();
  });

  it("opens on the saved status and clears it", async () => {
    const saved: AwayStatus = {
      ...vacation(),
      autoreply: { enabled: true, text: "Я в отпуске." },
      mute_push: true,
      version: 3,
    };
    const { api, wrap } = harness({
      features: ["actor_away"],
      away: saved,
      user: { away: vacation() },
    });
    const onClose = vi.fn();
    wrap(<StatusDialog onClose={onClose} />);
    const text = (await screen.findByLabelText(
      "Текст автоответа",
    )) as HTMLTextAreaElement;
    expect(text.value).toBe("Я в отпуске.");
    expect(
      screen.getByRole("radio", { name: /В отпуске/ }),
    ).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("button", { name: "Снять" }));
    await waitFor(() => expect(api.clearAway).toHaveBeenCalled());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("switches to the custom status tab", async () => {
    const { wrap } = harness({ features: ["actor_away"] });
    wrap(<StatusDialog onClose={vi.fn()} />);
    const tabs = await screen.findByRole("radiogroup", { name: "Вид статуса" });
    fireEvent.click(within(tabs).getByRole("radio", { name: "Свой статус" }));
    expect(await screen.findByLabelText("Текст статуса")).toBeInTheDocument();
    expect(screen.getByText("Быстрые статусы")).toBeInTheDocument();
  });
});

describe("Composer away hint", () => {
  function Draft({ members }: { members: ChatMember[] }) {
    const [body, setBody] = useState(
      `@[Олег Чернов](${oleg}) сможешь в среду?`,
    );
    const hints = useAwayMentionHints(body, members);
    return (
      <>
        <Composer
          members={members}
          body={body}
          setBody={setBody}
          onBlur={() => undefined}
          onSend={() => undefined}
          reply={null}
          onCancelReply={() => undefined}
          readonly={false}
          awayHints={hints}
        />
        <output data-testid="body">{body}</output>
      </>
    );
  }

  it("says Anna is away and mentions the substitute", async () => {
    const { wrap } = harness({ features: ["actor_away"] });
    const members = [
      person(me, "Анна Иванова", "anna"),
      person(oleg, "Олег Чернов", "oleg", vacation()),
      person(marina, "Марина Соколова", "marina"),
    ];
    wrap(<Draft members={members} />);
    const hint = await screen.findByText(
      /Олег в отпуске до .* — уведомление не придёт/,
    );
    expect(hint).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Упомянуть Марину" }));
    expect(screen.getByTestId("body").textContent).toContain(marina);
  });

  it("stays quiet when nobody mentioned is away", async () => {
    const { wrap } = harness({ features: ["actor_away"] });
    wrap(
      <Draft
        members={[
          person(me, "Анна Иванова", "anna"),
          person(oleg, "Олег Чернов", "oleg"),
          person(marina, "Марина Соколова", "marina"),
        ]}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("status", { name: "Кого нет на месте" })).toBeNull();
  });
});
