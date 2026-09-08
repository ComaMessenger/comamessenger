import { useEffect, type RefObject } from "react";

/** Closes a popover on outside pointer interaction or Escape. */
export function useDismissable(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
  secondaryRef?: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!open) return;
    function pointer(event: PointerEvent) {
      const target = event.target as Node;
      if (
        !ref.current?.contains(target) &&
        !secondaryRef?.current?.contains(target)
      )
        onClose();
    }
    function keyboard(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("pointerdown", pointer);
    document.addEventListener("keydown", keyboard);
    return () => {
      document.removeEventListener("pointerdown", pointer);
      document.removeEventListener("keydown", keyboard);
    };
  }, [onClose, open, ref, secondaryRef]);
}
