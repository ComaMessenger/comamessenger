import { useEffect, useRef, useState } from "react";
import {
  Autosave,
  type AutosaveOptions,
  type AutosavePhase,
  type AutosaveState,
} from "@comamessenger/core";
import { messageOf } from "../../errors";

export type { AutosavePhase };

/** React binding of the shared `Autosave` controller (packages/core). */
export function useAutosave<T>({
  value,
  save,
  fingerprint = (item) => JSON.stringify(item),
  onSaved,
  delay = 650,
}: {
  value: T | null;
  save(value: T): Promise<T>;
  fingerprint?(value: T): string;
  onSaved?(result: T, snapshot: T): void;
  delay?: number;
}) {
  const [state, setState] = useState<AutosaveState>({
    phase: "idle",
    error: "",
  });
  const options: AutosaveOptions<T> = {
    save,
    fingerprint,
    onSaved,
    delay,
    describeError: messageOf,
  };
  const controller = useRef<Autosave<T> | null>(null);
  controller.current ??= new Autosave(options, setState);
  controller.current.configure(options);
  controller.current.track(value);
  const signature = value ? fingerprint(value) : null;

  useEffect(() => {
    controller.current?.update(value);
    // The draft is compared by its fingerprint, not by identity.
  }, [signature]);

  useEffect(() => () => controller.current?.dispose(), []);

  return {
    phase: state.phase,
    error: state.error,
    retry: () => controller.current?.retry(),
  };
}
