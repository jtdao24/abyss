// Keyboard focus for the panels that open over the market. They aren't modal
// (the market keeps running and stays clickable behind them), so focus isn't
// trapped: it moves into the panel when it opens and goes back to where it was
// when it closes. The finished-file viewer is modal and traps focus itself.
import { useEffect, type RefObject } from "react";

const FOCUSABLE = "button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex='-1'])";

export function useDialogFocus(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const el = ref.current;
    if (el && !el.contains(document.activeElement)) {
      const target = el.querySelector<HTMLElement>("[data-autofocus]") ?? el.querySelector<HTMLElement>(FOCUSABLE);
      target?.focus({ preventScroll: true });
    }
    return () => {
      // Only hand focus back if it's still in this panel (or lost with it).
      const active = document.activeElement;
      const lost = !active || active === document.body || (el?.contains(active) ?? false);
      if (lost && before && before !== document.body && document.contains(before)) before.focus({ preventScroll: true });
    };
  }, []);
}
