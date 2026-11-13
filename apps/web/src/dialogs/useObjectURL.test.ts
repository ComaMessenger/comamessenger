import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessengerAPI } from "@comamessenger/core";
import { useObjectURLState } from "./useObjectURL";

describe("useObjectURLState", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reports a failed download and loads again on retry", async () => {
    // jsdom has no object URLs.
    Object.assign(URL, { createObjectURL: vi.fn(() => "blob:photo"), revokeObjectURL: vi.fn() });
    const downloadFile = vi
      .fn()
      .mockRejectedValueOnce(new Error("404"))
      .mockResolvedValueOnce(new Blob(["x"], { type: "image/png" }));
    const api = { downloadFile } as unknown as MessengerAPI;
    const { result } = renderHook(() => useObjectURLState(api, "file-1"));
    // Not «loading» forever: the failure shows.
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.url).toBeNull();
    act(() => result.current.retry());
    expect(result.current.failed).toBe(false);
    await waitFor(() => expect(result.current.url).toBe("blob:photo"));
    expect(result.current.failed).toBe(false);
    expect(downloadFile).toHaveBeenCalledTimes(2);
  });

  it("starts clean for another file", async () => {
    const downloadFile = vi.fn().mockRejectedValue(new Error("gone"));
    const api = { downloadFile } as unknown as MessengerAPI;
    const { result, rerender } = renderHook(({ id }) => useObjectURLState(api, id), {
      initialProps: { id: "file-1" as string | undefined },
    });
    await waitFor(() => expect(result.current.failed).toBe(true));
    rerender({ id: undefined });
    expect(result.current.failed).toBe(false);
  });
});
