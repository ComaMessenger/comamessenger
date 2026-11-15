import { describe, expect, it } from "vitest";
import { APIError } from "./api";
import { deviceTimezone, syncDeviceTimezone, timezoneToSync } from "./timezone";
import type { User } from "./types";

function api(result: () => Promise<User>) {
  const calls: unknown[] = [];
  return {
    calls,
    updateMe(input: Partial<Pick<User, "timezone">>) {
      calls.push(input);
      return result();
    },
  };
}

const updated = { timezone: "Europe/Moscow" } as User;

describe("syncDeviceTimezone", () => {
  it("writes the device zone over the default UTC", async () => {
    const client = api(async () => updated);
    expect(
      await syncDeviceTimezone(client, { timezone: "UTC" }, "Europe/Moscow"),
    ).toBe(updated);
    expect(client.calls).toEqual([{ timezone: "Europe/Moscow" }]);
  });

  it("writes over an empty zone too", async () => {
    const client = api(async () => updated);
    await syncDeviceTimezone(client, { timezone: "" }, "Asia/Yekaterinburg");
    expect(client.calls).toEqual([{ timezone: "Asia/Yekaterinburg" }]);
  });

  it("never touches a zone the person chose", async () => {
    const client = api(async () => updated);
    expect(
      await syncDeviceTimezone(
        client,
        { timezone: "Europe/Berlin" },
        "Europe/Moscow",
      ),
    ).toBeNull();
    expect(client.calls).toEqual([]);
  });

  it("does nothing when the device is in UTC or does not know", async () => {
    const client = api(async () => updated);
    expect(
      await syncDeviceTimezone(client, { timezone: "UTC" }, "UTC"),
    ).toBeNull();
    expect(
      await syncDeviceTimezone(client, { timezone: "UTC" }, "Etc/UTC"),
    ).toBeNull();
    expect(
      await syncDeviceTimezone(client, { timezone: "UTC" }, null),
    ).toBeNull();
    expect(client.calls).toEqual([]);
  });

  it("stays quiet when the server refuses", async () => {
    const client = api(async () => {
      throw new APIError(422, "validation_failed", "bad zone");
    });
    expect(
      await syncDeviceTimezone(client, { timezone: "UTC" }, "Mars/Olympus"),
    ).toBeNull();
  });

  it("reads the device zone", () => {
    expect(timezoneToSync("UTC", "Europe/Moscow")).toBe("Europe/Moscow");
    expect(typeof deviceTimezone()).toBe("string");
  });
});
