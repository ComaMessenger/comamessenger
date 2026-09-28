import { describe, expect, it } from "vitest";
import { normalizeServerURL } from "./server";

describe("normalizeServerURL", () => {
  it("defaults to HTTPS and strips trailing slashes and default ports", () => {
    expect(normalizeServerURL("  Chat.Acme.ru ")).toBe("https://chat.acme.ru");
    expect(normalizeServerURL("https://acme.ru:443/coma/")).toBe(
      "https://acme.ru/coma",
    );
    expect(normalizeServerURL("https://acme.ru:8443")).toBe(
      "https://acme.ru:8443",
    );
  });

  it("allows plain HTTP only for local development hosts", () => {
    expect(normalizeServerURL("http://localhost:8080")).toBe(
      "http://localhost:8080",
    );
    expect(normalizeServerURL("http://10.0.2.2:8080/")).toBe(
      "http://10.0.2.2:8080",
    );
    expect(normalizeServerURL("http://chat.acme.ru")).toBeNull();
  });

  it("rejects values that are not an instance address", () => {
    for (const value of [
      "",
      "ftp://acme.ru",
      "https://user@acme.ru",
      "https://acme.ru?next=/",
      "https://acme.ru:70000",
      "acme ru",
    ])
      expect(normalizeServerURL(value)).toBeNull();
  });
});
