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

describe("sessionLabel for the phone app", () => {
  it("names the iOS app by its networking stack", () => {
    expect(
      sessionLabel("Coma/57 CFNetwork/3826.500.62 Darwin/25.0.0", "?", {
        nativeApp: "Coma",
      }),
    ).toBe("Coma · iOS");
  });

  it("names the Android app by okhttp", () => {
    expect(sessionLabel("okhttp/4.12.0", "?", { nativeApp: "Coma" })).toBe(
      "Coma · Android",
    );
  });

  it("keeps the web behaviour without the option", () => {
    expect(sessionLabel("okhttp/4.12.0", "Unknown device")).toBe(
      "Unknown device",
    );
  });
});
