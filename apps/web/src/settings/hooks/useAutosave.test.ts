import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutosave } from "./useAutosave";

type Draft = { name: string };

describe("useAutosave", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("debounces changes and persists only the latest snapshot", async () => {
    const save = vi.fn(async (value: Draft) => value);
    const { result, rerender } = renderHook(
      ({ value }) => useAutosave({ value, save, delay: 100 }),
      { initialProps: { value: { name: "initial" } } },
    );

    rerender({ value: { name: "first" } });
    rerender({ value: { name: "latest" } });

    expect(result.current.phase).toBe("dirty");
    expect(save).not.toHaveBeenCalled();

    await act(() => vi.advanceTimersByTimeAsync(100));

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ name: "latest" });
  });

  it("serializes a newer change made while a save is in flight", async () => {
    let resolveFirst!: (value: Draft) => void;
    const firstSave = new Promise<Draft>((resolve) => {
      resolveFirst = resolve;
    });
    const save = vi
      .fn<(value: Draft) => Promise<Draft>>()
      .mockImplementationOnce(() => firstSave)
      .mockImplementation(async (value) => value);
    const { rerender } = renderHook(
      ({ value }) => useAutosave({ value, save, delay: 100 }),
      { initialProps: { value: { name: "initial" } } },
    );

    rerender({ value: { name: "first" } });
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(save).toHaveBeenCalledTimes(1);

    rerender({ value: { name: "latest" } });
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(save).toHaveBeenCalledTimes(1);

    await act(async () => resolveFirst({ name: "first" }));
    await act(() => vi.advanceTimersByTimeAsync(100));

    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith({ name: "latest" });
  });

  it("exposes an error and retries the current value", async () => {
    const save = vi
      .fn<(value: Draft) => Promise<Draft>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementation(async (value) => value);
    const { result, rerender } = renderHook(
      ({ value }) => useAutosave({ value, save, delay: 100 }),
      { initialProps: { value: { name: "initial" } } },
    );

    rerender({ value: { name: "changed" } });
    await act(() => vi.advanceTimersByTimeAsync(100));

    expect(result.current.phase).toBe("error");
    expect(result.current.error).toBe("offline");

    await act(async () => result.current.retry());

    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith({ name: "changed" });
  });
});
