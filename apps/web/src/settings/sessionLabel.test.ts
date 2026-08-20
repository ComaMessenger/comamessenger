import { describe, expect, it } from "vitest";
import { sessionLabel } from "./sessionLabel";

describe("sessionLabel", () => {
  it("describes a Chrome session on macOS", () => {
    expect(
      sessionLabel(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0 Safari/537.36",
        "Unknown device",
      ),
    ).toBe("Chrome · macOS");
  });

  it("does not expose an unrecognized raw user agent", () => {
    expect(sessionLabel("custom-client/1.0", "Unknown device")).toBe(
      "Unknown device",
    );
  });
});
