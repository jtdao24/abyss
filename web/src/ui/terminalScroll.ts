// Scrollback helpers for the Captain terminal (pure, so they're easy to test).
import type { AbyssEvent } from "../contract";

/** How close to the bottom (px) still counts as "reading the newest line". */
export const PIN_SLACK_PX = 80;

type Scrollable = { scrollHeight: number; scrollTop: number; clientHeight: number };

/**
 * True when the view shows the newest lines. Measure this when the user
 * scrolls, not after new lines arrive: a burst of lines taller than the slack
 * would otherwise look like "the user scrolled up" and unpin the view for good.
 */
export function nearBottom(el: Scrollable, slack = PIN_SLACK_PX): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < slack;
}

// A stable key per event object. `seq` alone repeats (every connection's hello
// is seq 0), and an array index shifts once the log starts dropping old events.
const keys = new WeakMap<AbyssEvent, number>();
let nextKey = 1;
export function eventKey(ev: AbyssEvent): number {
  let key = keys.get(ev);
  if (key === undefined) {
    key = nextKey++;
    keys.set(ev, key);
  }
  return key;
}
