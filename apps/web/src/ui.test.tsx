import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Button, Dialog } from "./ui";
describe("web primitives", () => {
  it("keeps explicit button semantics", () => {
    render(<Button variant="primary">Save</Button>);
    expect(screen.getByRole("button", { name: "Save" })).toBeVisible();
  });
  it("closes a dialog with Escape", () => {
    const close = vi.fn();
    render(
      <Dialog title="Settings" onClose={close}>
        <button>Action</button>
      </Dialog>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(close).toHaveBeenCalledOnce();
  });
});
