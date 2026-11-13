import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const git = (...args: string[]) =>
  execFileSync("git", args, { encoding: "utf8" }).trim();

describe("repository hygiene", () => {
  it("keeps patch(1) leftovers out of the tree and ignored", () => {
    expect(git("ls-files", "--", ":(glob)**/*.orig", ":(glob)**/*.rej")).toBe(
      "",
    );
    expect(git("check-ignore", "--no-index", "apps/web/src/x.tsx.orig")).toBe(
      "apps/web/src/x.tsx.orig",
    );
    expect(
      git("check-ignore", "--no-index", "packages/core/src/x.ts.rej"),
    ).toBe("packages/core/src/x.ts.rej");
  });
});
