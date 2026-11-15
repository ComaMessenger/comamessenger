import { describe, expect, it } from "vitest";
import { nextAspect } from "./aspect";

describe("nextAspect", () => {
  it("lets a preview fill in an unknown aspect", () => {
    expect(nextAspect({}, 4 / 3, "preview")).toEqual({
      aspect: 4 / 3,
      aspectFrom: "preview",
    });
  });

  it("keeps the photo's own aspect when a sideways preview reloads", () => {
    // The original in the viewer said portrait; the old server preview of
    // the same photo is landscape. Back in the chat the tile must not flip.
    const full = { aspect: 3 / 4, aspectFrom: "full" as const };
    expect(nextAspect(full, 4 / 3, "preview")).toBeNull();
  });

  it("lets the photo itself correct what a preview said", () => {
    expect(
      nextAspect({ aspect: 4 / 3, aspectFrom: "preview" }, 3 / 4, "full"),
    ).toEqual({ aspect: 3 / 4, aspectFrom: "full" });
  });

  it("treats facts stored before sources were tracked as a preview's", () => {
    expect(nextAspect({ aspect: 4 / 3 }, 3 / 4, "preview")).toEqual({
      aspect: 3 / 4,
      aspectFrom: "preview",
    });
    expect(nextAspect({ aspect: 4 / 3 }, 3 / 4, "full")).toEqual({
      aspect: 3 / 4,
      aspectFrom: "full",
    });
  });

  it("ignores nothing new and nonsense", () => {
    expect(
      nextAspect({ aspect: 1.5, aspectFrom: "full" }, 1.5, "full"),
    ).toBeNull();
    expect(nextAspect({}, 0, "full")).toBeNull();
    expect(nextAspect({}, Number.NaN, "full")).toBeNull();
    expect(nextAspect({}, Number.POSITIVE_INFINITY, "preview")).toBeNull();
  });
});
