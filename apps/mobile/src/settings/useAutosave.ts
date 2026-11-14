import { useEffect, useRef, useState } from "react";
import {
  Autosave,
  type AutosaveOptions,
  type AutosaveState,
} from "@comamessenger/core";
import { messageOf } from "@/lib/errors";

/**
 * Saves a settings draft shortly after the last change; the same controller
 * as on the web (packages/core). `value: null` keeps it idle.
 */
export function useAutosave<T>({
  value,
  save,
  fingerprint = (item) => JSON.stringify(item),
  onSaved,
  describeError = messageOf,
  delay = 650,
}: {
  value: T | null;
  save(value: T): Promise<T>;
  fingerprint?(value: T): string;
  onSaved?(result: T, snapshot: T): void;
  describeError?(cause: unknown): string;
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
    describeError,
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

  return { ...state, retry: () => controller.current?.retry() };
}
