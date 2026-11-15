import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createMessengerStore,
  type ActorSummary,
  type MessengerAPI,
  type OrgDepartment,
  type OrgStructure,
  type User,
} from "@comamessenger/core";
import { setLocale } from "../i18n";
import {
  MessengerContext,
  type MessengerContextValue,
} from "../shell/MessengerContext";
import { ToastProvider } from "../shell/ToastProvider";
import { OrgTree } from "../directories/OrgTree";
import { DepartmentProfile } from "../directories/DepartmentProfile";
import { WorkspaceOrgPage } from "../settings/pages/workspace/WorkspaceOrgPage";
import { RequestDialog } from "../requests/RequestDialog";
import type { ChatMember, Message } from "@comamessenger/core";

const id = (prefix: string, n: number) =>
  `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const rehab = id("10000000", 1);
const gym = id("10000000", 2);
const pool = id("10000000", 3);
const admin = id("10000000", 4);
const anna = id("20000000", 1);
const oleg = id("20000000", 2);
const boris = id("20000000", 3);
const elena = id("20000000", 5);

function department(
  departmentID: string,
  name: string,
  parent: string | null,
  lead: string | null,
  extra: Partial<OrgDepartment> = {},
): OrgDepartment {
  return {
    id: departmentID,
    parent_id: parent,
    name,
    lead_actor_id: lead,
    chat_id: null,
    has_chat: false,
    chat_archived: false,
    sort_key: null,
    version: 1,
    ...extra,
  };
}

function structure(patch: Partial<OrgDepartment> = {}): OrgStructure {
  return {
    version: 5,
    departments: [
      department(rehab, "Rehabilitation", null, anna),
      department(gym, "Gym", rehab, oleg, patch),
      department(pool, "Pool", rehab, null),
      department(admin, "Office", null, elena),
    ],
    positions: [{ id: id("30000000", 1), name: "Doctor", sort_key: null, version: 1 }],
    people: [
      {
        actor_id: anna,
        primary_department_id: rehab,
        additional_department_ids: [],
        position_id: id("30000000", 1),
      },
      { actor_id: oleg, primary_department_id: gym, additional_department_ids: [], position_id: null },
      { actor_id: boris, primary_department_id: gym, additional_department_ids: [], position_id: null },
      { actor_id: elena, primary_department_id: admin, additional_department_ids: [], position_id: null },
    ],
  };
}

const actor = (actorID: string, name: string): ActorSummary => ({
  actor_id: actorID,
  display_name: name,
  handle: name.toLowerCase(),
  title: "",
  about: "",
  type: "user",
  status_emoji: "",
  status_text: "",
  status_expires_at: null,
  avatar_version: 0,
});
const actors = [
  actor(anna, "Anna"),
  actor(oleg, "Oleg"),
  actor(boris, "Boris"),
  actor(elena, "Elena"),
];
const actorMap = new Map(actors.map((item) => [item.actor_id, item]));

function user(actorID: string, role: User["role"], permissions: string[] = []): User {
  return {
    id: actorID,
    org_id: id("00000000", 10),
    organization_name: "Opora",
    role,
    permissions,
    email: "x@example.com",
    display_name: actorMap.get(actorID)?.display_name ?? "X",
    handle: "x",
    title: "",
    about: "",
    timezone: "Europe/Moscow",
    status: "active",
    must_change_password: false,
    can_create_invitations: false,
    status_emoji: "",
    status_text: "",
    status_expires_at: null,
    avatar_version: 0,
    created_at: "2026-08-19T00:00:00Z",
  } as unknown as User;
}

function renderWith(
  ui: ReactNode | ((api: MessengerAPI) => ReactNode),
  options: { user: User; api?: Partial<MessengerAPI>; org?: OrgStructure },
) {
  const store = createMessengerStore();
  store.getState().setFeatures(["org_structure"]);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const api = {
    orgStructure: vi.fn(async () => options.org ?? structure()),
    actors: vi.fn(async () => ({ actors, next_after_id: null })),
    ...options.api,
  } as unknown as MessengerAPI;
  const navigate = vi.fn();
  const value = {
    api,
    user: options.user,
    store,
    navigate,
    reload: vi.fn(async () => undefined),
  } as unknown as MessengerContextValue;
  render(
    <QueryClientProvider client={client}>
      <MessengerContext.Provider value={value}>
        <ToastProvider>{typeof ui === "function" ? ui(api) : ui}</ToastProvider>
      </MessengerContext.Provider>
    </QueryClientProvider>,
  );
  return { api, navigate };
}

beforeAll(async () => {
  await setLocale("en");
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("OrgTree", () => {
  it("is a keyboard tree with aria-expanded", async () => {
    const onOpen = vi.fn();
    renderWith(
      <OrgTree
        structure={structure()}
        actors={actorMap}
        label="Org"
        onOpen={onOpen}
      />,
      { user: user(anna, "owner") },
    );
    const tree = screen.getByRole("tree", { name: "Org" });
    const items = () => within(tree).getAllByRole("treeitem");
    expect(items().map((item) => item.getAttribute("aria-label"))).toEqual([
      "Office, 1 people",
      "Rehabilitation, 3 people",
      "Gym, 2 people",
      "Pool, 0 people",
    ]);
    const parent = items()[1]!;
    expect(parent).toHaveAttribute("aria-expanded", "true");
    expect(parent).toHaveAttribute("aria-level", "1");
    expect(items()[2]).toHaveAttribute("aria-level", "2");
    // A leaf has no aria-expanded at all.
    expect(items()[0]).not.toHaveAttribute("aria-expanded");

    // Roving focus: only one row is in the tab order.
    expect(items().filter((item) => item.tabIndex === 0)).toHaveLength(1);
    items()[0]!.focus();
    fireEvent.keyDown(items()[0]!, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(items()[1]));

    fireEvent.keyDown(items()[1]!, { key: "ArrowLeft" });
    await waitFor(() => expect(items()).toHaveLength(2));
    expect(items()[1]).toHaveAttribute("aria-expanded", "false");
    // Folded branches are remembered.
    expect(localStorage.getItem("coma-org-tree-collapsed")).toContain(rehab);

    fireEvent.keyDown(items()[1]!, { key: "ArrowRight" });
    await waitFor(() => expect(items()).toHaveLength(4));
    fireEvent.keyDown(items()[1]!, { key: "ArrowRight" });
    await waitFor(() => expect(document.activeElement).toBe(items()[2]));
    // Left on a leaf goes to its parent.
    fireEvent.keyDown(items()[2]!, { key: "ArrowLeft" });
    await waitFor(() => expect(document.activeElement).toBe(items()[1]));

    fireEvent.keyDown(items()[1]!, { key: "End" });
    await waitFor(() => expect(document.activeElement).toBe(items()[3]));
    fireEvent.keyDown(items()[3]!, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith(pool);
  });

  it("filters by department, lead and people and keeps parents", () => {
    renderWith(
      <OrgTree
        structure={structure()}
        actors={actorMap}
        label="Org"
        query="boris"
        onOpen={() => undefined}
      />,
      { user: user(anna, "owner") },
    );
    expect(
      screen.getAllByRole("treeitem").map((item) => item.getAttribute("aria-label")),
    ).toEqual(["Rehabilitation, 3 people", "Gym, 2 people"]);
  });
});

describe("DepartmentProfile actions by rights", () => {
  const card = (org: OrgStructure) => (
    <DepartmentProfile
      departmentID={gym}
      structure={org}
      actors={actorMap}
      onBack={() => undefined}
    />
  );

  it("the owner creates the chat, edits and links", () => {
    renderWith(card(structure()), { user: user(anna, "owner") });
    expect(screen.getByRole("button", { name: /Create department chat/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /Edit/ })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Department actions" }));
    expect(screen.getByRole("menuitem", { name: "Link a chat" })).toBeVisible();
  });

  it("the lead creates the chat but does not edit the structure", () => {
    renderWith(card(structure()), { user: user(oleg, "member") });
    expect(screen.getByRole("button", { name: /Create department chat/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Edit/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Department actions" })).toBeVisible();
  });

  it("org.manage edits; a plain member only reads", () => {
    renderWith(card(structure()), { user: user(boris, "member", ["org.manage"]) });
    expect(screen.getByRole("button", { name: /Edit/ })).toBeVisible();
    cleanup();
    renderWith(card(structure()), { user: user(boris, "member") });
    expect(screen.queryByRole("button", { name: /Create department chat/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Edit/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Department actions" })).toBeNull();
  });

  it("someone outside the chat is told to ask the lead", () => {
    renderWith(card(structure({ has_chat: true })), { user: user(boris, "member") });
    expect(screen.getByText(/you are not in it/)).toBeVisible();
    expect(screen.queryByRole("button", { name: /Department chat/ })).toBeNull();
  });

  it("the lead in the chat adds the missing people", async () => {
    const chat = id("40000000", 1);
    const departmentChatMissing = vi.fn(async () => [actorMap.get(boris)!]);
    const addDepartmentChatMissing = vi.fn(async () => 1);
    renderWith(card(structure({ chat_id: chat, has_chat: true })), {
      user: user(oleg, "member"),
      api: { departmentChatMissing, addDepartmentChatMissing },
    });
    expect(screen.getByRole("button", { name: /Department chat/ })).toBeVisible();
    expect(
      await screen.findByText("1 person of the department not in the chat"),
    ).toBeVisible();
    departmentChatMissing.mockResolvedValue([]);
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(addDepartmentChatMissing).toHaveBeenCalledWith(gym));
    await waitFor(() =>
      expect(screen.queryByText(/not in the chat/)).toBeNull(),
    );
  });
});

describe("WorkspaceOrgPage", () => {
  it("deletes a department and moves its people where chosen", async () => {
    const deleteDepartment = vi.fn(async () => undefined);
    const owner = user(anna, "owner");
    renderWith(
      (api) => (
        <WorkspaceOrgPage api={api} user={owner} navigate={() => undefined} />
      ),
      { user: owner, api: { deleteDepartment } },
    );
    expect(await screen.findByRole("tab", { name: "Departments" })).toBeVisible();
    fireEvent.click(await screen.findByRole("button", { name: /^Gym/ }));
    expect(await screen.findByRole("heading", { name: "Gym" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Department actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete department" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Gym?" });
    // Its people go to the parent by default.
    const target = within(dialog).getByRole("button", {
      name: /^Where 2 people go/,
    });
    expect(target).toHaveAccessibleName("Where 2 people go Rehabilitation");
    expect(within(dialog).getByText(/Additional memberships/)).toBeVisible();
    fireEvent.click(target);
    fireEvent.click(await screen.findByRole("option", { name: "Office" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete department" }));
    await waitFor(() => expect(deleteDepartment).toHaveBeenCalledWith(gym, admin));
  });

  it("says where subdepartments go and what «no department» means", async () => {
    const owner = user(anna, "owner");
    renderWith(
      (api) => (
        <WorkspaceOrgPage api={api} user={owner} navigate={() => undefined} />
      ),
      { user: owner },
    );
    fireEvent.click(await screen.findByRole("button", { name: /^Rehabilitation/ }));
    fireEvent.click(screen.getByRole("button", { name: "Department actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete department" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Rehabilitation?" });
    expect(within(dialog).getByText("2 subdepartments become top level.")).toBeVisible();
    expect(
      within(dialog).getByRole("button", { name: /^Where 1 person goes/ }),
    ).toHaveAccessibleName("Where 1 person goes No department");
    expect(within(dialog).getByText(/oldest additional department/)).toBeVisible();
  });

  it("is closed to a member without org.manage", () => {
    const member = user(boris, "member");
    renderWith(
      (api) => (
        <WorkspaceOrgPage api={api} user={member} navigate={() => undefined} />
      ),
      { user: member },
    );
    expect(screen.queryByRole("tab", { name: "Departments" })).toBeNull();
  });
});

describe("RequestDialog addressees from the structure", () => {
  const chatMember = (actorID: string): ChatMember =>
    ({
      ...actorMap.get(actorID)!,
      role: "member",
      joined_at: "2026-08-19T00:00:00Z",
    }) as unknown as ChatMember;
  const members = [anna, oleg, boris].map(chatMember);

  it("has no group segments without the right", () => {
    render(
      <RequestDialog
        chatID="c1"
        userID={anna}
        members={members}
        createRequest={vi.fn()}
        onSent={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(screen.getAllByRole("radio").map((item) => item.textContent)).toEqual(
      expect.arrayContaining(["Whole chat", "People"]),
    );
    expect(screen.queryByRole("radio", { name: "Department" })).toBeNull();
  });

  it("sends to a department with its subdepartments", async () => {
    sessionStorage.clear();
    const createRequest = vi.fn(
      async (_chatID: string, input: { client_msg_id: string }) =>
        ({ id: "m1", client_msg_id: input.client_msg_id }) as unknown as Message,
    );
    render(
      <RequestDialog
        chatID="c1"
        userID={anna}
        members={members}
        segments={["chat", "people", "department", "position"]}
        structure={structure()}
        createRequest={createRequest}
        onSent={() => undefined}
        onClose={() => undefined}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Question" }), {
      target: { value: "Read the schedule" },
    });
    fireEvent.click(screen.getByRole("radio", { name: "Department" }));
    const list = screen.getByRole("radiogroup", { name: "Department" });
    // The first department in tree order is preselected: Office has
    // nobody of this chat.
    expect(within(list).getByRole("radio", { name: /^Office/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(
      within(list).getByRole("radio", { name: /^Rehabilitation/ }),
    ).toHaveTextContent("with subdepartments · 3 ppl · in this chat: 2");
    fireEvent.click(within(list).getByRole("radio", { name: /^Rehabilitation/ }));
    const send = screen.getByRole("button", { name: "Send request · 2 people" });
    fireEvent.click(send);
    await waitFor(() => expect(createRequest).toHaveBeenCalled());
    expect(createRequest.mock.calls[0]![1]).toMatchObject({
      audience: { kind: "department", department_id: rehab },
    });
  });
});
