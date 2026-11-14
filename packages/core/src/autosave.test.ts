import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Autosave, type AutosaveState } from "./autosave";

type Draft = { name: string };

function controller(save: (value: Draft) => Promise<Draft>) {
  const states: AutosaveState[] = [];
  const autosave = new Autosave<Draft>(
    {
      save,
      fingerprint: (value) => JSON.stringify(value),
      describeError: (cause) => (cause as Error).message,
      delay: 100,
    },
    (state) => states.push(state),
  );
  return { autosave, states };
}

describe("Autosave", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("takes the first value as saved and debounces later ones", async () => {
    const save = vi.fn(async (value: Draft) => value);
    const { autosave } = controller(save);
    autosave.update({ name: "initial" });
    autosave.update({ name: "first" });
    autosave.update({ name: "latest" });
    expect(autosave.current.phase).toBe("dirty");
    await vi.advanceTimersByTimeAsync(100);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ name: "latest" });
    await vi.advanceTimersByTimeAsync(60);
    expect(autosave.current.phase).toBe("saved");
  });

  it("does not save a change undone before the delay", async () => {
    const save = vi.fn(async (value: Draft) => value);
    const { autosave } = controller(save);
    autosave.update({ name: "initial" });
    autosave.update({ name: "typo" });
    autosave.update({ name: "initial" });
    await vi.advanceTimersByTimeAsync(200);
    expect(save).not.toHaveBeenCalled();
  });

  it("saves a change made during a save right after it", async () => {
    let resolveFirst!: (value: Draft) => void;
    const save = vi
      .fn<(value: Draft) => Promise<Draft>>()
      .mockImplementationOnce(
        () => new Promise<Draft>((resolve) => (resolveFirst = resolve)),
      )
      .mockImplementation(async (value) => value);
    const { autosave } = controller(save);
    autosave.update({ name: "initial" });
    autosave.update({ name: "first" });
    await vi.advanceTimersByTimeAsync(100);
    autosave.update({ name: "latest" });
    await vi.advanceTimersByTimeAsync(100);
    expect(save).toHaveBeenCalledTimes(1);
    resolveFirst({ name: "first" });
    await vi.advanceTimersByTimeAsync(100);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith({ name: "latest" });
  });

  it("reports an error and retries the current value", async () => {
    const save = vi
      .fn<(value: Draft) => Promise<Draft>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementation(async (value) => value);
    const { autosave } = controller(save);
    autosave.update({ name: "initial" });
    autosave.update({ name: "changed" });
    await vi.advanceTimersByTimeAsync(100);
    expect(autosave.current).toEqual({ phase: "error", error: "offline" });
    autosave.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith({ name: "changed" });
  });

  it("waits for a value before taking a baseline", async () => {
    const save = vi.fn(async (value: Draft) => value);
    const { autosave } = controller(save);
    autosave.update(null);
    autosave.update({ name: "loaded" });
    await vi.advanceTimersByTimeAsync(200);
    expect(save).not.toHaveBeenCalled();
    expect(autosave.current.phase).toBe("idle");
  });
});
