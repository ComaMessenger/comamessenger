import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Avatar, Button, Dialog, RadioOption, SelectField } from "./ui";
describe("web primitives", () => {
  it("keeps explicit button semantics", () => {
    render(<Button variant="primary">Save</Button>);
    expect(screen.getByRole("button", { name: "Save" })).toBeVisible();
  });
  it("closes a dialog with Escape", () => {
    const close = vi.fn();
    const view = render(
      <Dialog title="Settings" onClose={close}>
        <button>Action</button>
      </Dialog>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(close).toHaveBeenCalledOnce();
  });
  it("exposes radio options through native form semantics", () => {
    const change = vi.fn();
    render(
      <RadioOption
        name="mode"
        label="Enter sends"
        description="Shift + Enter inserts a line"
        onChange={change}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: /Enter sends/ }));
    expect(change).toHaveBeenCalledOnce();
  });
  it("renders a custom dropdown while preserving native form semantics", () => {
    const change = vi.fn();
    const view = render(
      <SelectField label="Category" name="category" onChange={change}>
        <option value="all">All</option>
        <option value="agents">Agents</option>
      </SelectField>,
    );
    fireEvent.click(screen.getByRole("button", { name: /All/ }));
    fireEvent.click(
      within(screen.getByRole("listbox", { name: "Category" })).getByRole(
        "option",
        { name: "Agents" },
      ),
    );
    expect(view.container.querySelector("select[name='category']")).toHaveValue(
      "agents",
    );
    expect(change).toHaveBeenCalledOnce();
  });
  it("keeps an avatar color stable when its label changes", () => {
    const view = render(<Avatar name="First name" seed="chat-01" online />);
    const before =
      view.container.firstElementChild?.getAttribute("data-avatar-color");
    view.rerender(<Avatar name="Renamed chat" seed="chat-01" online />);
    expect(before).toMatch(/^[0-5]$/);
    expect(view.container.firstElementChild).toHaveAttribute(
      "data-avatar-color",
      before,
    );
    const face = view.container.querySelector<HTMLElement>(".ui-avatar__face");
    const online = view.container.querySelector<HTMLElement>(".ui-avatar > i");
    expect(face).toHaveTextContent("RC");
    expect(face).not.toContainElement(online);
  });
});
