import { describe, expect, it } from "vitest";
import { recentPhotoPlan } from "./recentPhoto";

describe("recentPhotoPlan", () => {
  it("re-encodes an iPhone HEIC as an upright JPEG", () => {
    expect(recentPhotoPlan("IMG_0007.HEIC", "fallback.jpg")).toEqual({
      reencode: true,
      name: "IMG_0007.jpg",
      mime: "image/jpeg",
    });
  });

  it("re-encodes a JPEG too: its turn may sit in EXIF", () => {
    expect(recentPhotoPlan("IMG_0008.JPG", "fallback.jpg")).toEqual({
      reencode: true,
      name: "IMG_0008.jpg",
      mime: "image/jpeg",
    });
  });

  it("keeps screenshots and GIFs as they are", () => {
    expect(recentPhotoPlan("Screenshot.PNG", "x.jpg")).toEqual({
      reencode: false,
      name: "Screenshot.PNG",
      mime: "image/png",
    });
    expect(recentPhotoPlan("cat.gif", "x.jpg")).toEqual({
      reencode: false,
      name: "cat.gif",
      mime: "image/gif",
    });
  });

  it("names a photo without a file name", () => {
    expect(recentPhotoPlan("", "photo-1.jpg")).toEqual({
      reencode: true,
      name: "photo-1.jpg",
      mime: "image/jpeg",
    });
    expect(recentPhotoPlan(undefined, "photo-2.jpg").name).toBe("photo-2.jpg");
  });
});
