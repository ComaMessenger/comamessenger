import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  InfrastructureSettings,
  MessengerAPI,
  User,
} from "@comamessenger/core";
import { setLocale } from "../../i18n";
import { InfrastructureSettingsPage } from "./InfrastructureSettingsPage";

const owner = {
  id: "01900000-0000-7000-8000-000000000001",
  actor_id: "01900000-0000-7000-8000-000000000001",
  role: "owner",
  permissions: [],
  display_name: "Owner",
  handle: "owner",
  email: "owner@example.com",
} as unknown as User;

const settings: InfrastructureSettings = {
  version: 3,
  s3: {
    endpoint: "",
    region: "",
    bucket: "",
    prefix: "",
    force_path_style: false,
    credentials_configured: false,
  },
  smtp: {
    host: "",
    port: 587,
    username: "",
    from_address: "",
    from_name: "",
    security: "starttls",
    credentials_configured: false,
  },
  mail: {
    delivery: "coma",
    coma: {
      state: "active",
      used: 14,
      daily_limit: 100,
      per_recipient_limit: 6,
    },
  },
};

function renderPage(api: Partial<MessengerAPI>) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <InfrastructureSettingsPage
        api={api as MessengerAPI}
        user={owner}
        navigate={() => undefined}
      />
    </QueryClientProvider>,
  );
}

describe("mail delivery settings", () => {
  beforeAll(async () => {
    await setLocale("ru");
  });
  afterEach(cleanup);

  it("shows Coma mail state, the daily spend and the privacy note", async () => {
    renderPage({ infrastructure: vi.fn().mockResolvedValue(settings) });
    expect(
      await screen.findByRole("radio", { name: "Почта Coma" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Подключена")).toBeVisible();
    expect(screen.getByText(/За сутки отправлено: 14 из 100/)).toBeVisible();
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "14");
    expect(
      screen.getByText("Одному получателю: не больше 6 писем в сутки."),
    ).toBeVisible();
    expect(screen.getByText(/только счётчики и ссылки/)).toBeVisible();
    // SMTP fields stay hidden until own SMTP is chosen.
    expect(screen.queryByLabelText("Хост")).toBeNull();
  });

  it("switches to own SMTP only with a server and saves the choice", async () => {
    const update = vi.fn().mockImplementation(async () => ({
      ...settings,
      version: 4,
      smtp: { ...settings.smtp, host: "smtp.example.com" },
      mail: { delivery: "smtp" },
    }));
    renderPage({
      infrastructure: vi.fn().mockResolvedValue(settings),
      updateInfrastructure: update,
    });
    fireEvent.click(await screen.findByRole("radio", { name: "Свой SMTP" }));
    expect(screen.getByText("Для своего SMTP укажите сервер.")).toBeVisible();
    const save = screen.getByRole("button", { name: /Сохранить/ });
    expect(save).toBeDisabled();
    fireEvent.change(document.querySelector('input[name="smtp-host"]')!, {
      target: { value: "smtp.example.com" },
    });
    fireEvent.change(document.querySelector('input[name="smtp-from"]')!, {
      target: { value: "coma@example.com" },
    });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]![0]).toMatchObject({
      expected_version: 3,
      mail_delivery: "smtp",
      smtp: { host: "smtp.example.com" },
    });
  });

  it("can switch email off", async () => {
    const update = vi.fn().mockResolvedValue({
      ...settings,
      mail: { delivery: "off" },
    });
    renderPage({
      infrastructure: vi.fn().mockResolvedValue(settings),
      updateInfrastructure: update,
    });
    fireEvent.click(
      await screen.findByRole("radio", { name: "Не отправлять" }),
    );
    expect(screen.getByText(/Письма не уходят/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Сохранить/ }));
    await waitFor(() =>
      expect(update.mock.calls[0]![0]).toMatchObject({ mail_delivery: "off" }),
    );
  });
});
