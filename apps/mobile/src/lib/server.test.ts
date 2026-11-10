import { describe, expect, it } from "vitest";
import { parseInviteDeepLink } from "./inviteLinks";
import { displayServer, normalizeServerURL, parseServerInput } from "./server";

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

describe("parseServerInput", () => {
  it("extracts the server and token from an invitation link", () => {
    expect(parseServerInput("https://chat.acme.ru/invite/AbC_12-x")).toEqual({
      serverURL: "https://chat.acme.ru",
      inviteToken: "AbC_12-x",
    });
    expect(parseServerInput("chat.acme.ru")).toEqual({
      serverURL: "https://chat.acme.ru",
    });
    expect(parseServerInput("http://chat.acme.ru/invite/x")).toBeNull();
  });

  it("shows the server without the scheme", () => {
    expect(displayServer("https://acme.ru/coma")).toBe("acme.ru/coma");
  });
});

describe("parseInviteDeepLink", () => {
  it("reads the server and token from the app scheme", () => {
    expect(
      parseInviteDeepLink("coma://invite?server=chat.acme.ru&token=t0k-en"),
    ).toEqual({ serverURL: "https://chat.acme.ru", inviteToken: "t0k-en" });
    expect(parseInviteDeepLink("coma://invite?server=chat.acme.ru")).toBeNull();
    expect(parseInviteDeepLink("https://chat.acme.ru/invite/x")).toBeNull();
  });
});
