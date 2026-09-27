// Day and night on the boardwalk. By default the light follows this computer's
// clock: gold at sunset, blue at night, pink at dawn. The header button can pin
// it to day or night instead, remembered per browser.

export type TimeMode = "auto" | "day" | "night";

export interface Daylight {
  /** Multiplied over the scene: white leaves it as painted. */
  tint: string;
  /** How strongly the lanterns glow and the fireflies come out, 0 to 1. */
  lamps: number;
}

const MODE_KEY = "abyss.time";
export const TIME_MODES: TimeMode[] = ["auto", "day", "night"];

// [hour, tint, lamps], interpolated between neighbours.
const KEYS: [number, string, number][] = [
  [0, "#4a5aa0", 1],
  [5, "#4a5aa0", 1],
  [6.2, "#e8a6b4", 0.5], // dawn
  [7.5, "#ffffff", 0],
  [16.5, "#ffffff", 0],
  [18.5, "#ffb070", 0.45], // sunset
  [20, "#4a5aa0", 1],
  [24, "#4a5aa0", 1],
];

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function mixColor(a: string, b: string, t: number): string {
  const [ar, ag, ab] = rgb(a);
  const [br, bg, bb] = rgb(b);
  const c = (x: number, y: number) => Math.round(x + (y - x) * t).toString(16).padStart(2, "0");
  return `#${c(ar, br)}${c(ag, bg)}${c(ab, bb)}`;
}

/** The light at a given hour of the day (0 to 24, fractions allowed). */
export function daylightAt(hour: number): Daylight {
  const h = ((hour % 24) + 24) % 24;
  for (let i = 1; i < KEYS.length; i += 1) {
    const [h1, tint1, lamps1] = KEYS[i];
    if (h > h1) continue;
    const [h0, tint0, lamps0] = KEYS[i - 1];
    const t = h1 === h0 ? 0 : (h - h0) / (h1 - h0);
    return { tint: mixColor(tint0, tint1, t), lamps: lamps0 + (lamps1 - lamps0) * t };
  }
  return { tint: KEYS[0][1], lamps: KEYS[0][2] };
}

export function daylightFor(mode: TimeMode, now = new Date()): Daylight {
  if (mode === "day") return daylightAt(12);
  if (mode === "night") return daylightAt(0);
  return daylightAt(now.getHours() + now.getMinutes() / 60);
}

/** The manual mode a day/night action should offer for the current light. */
export function oppositeTimeMode(mode: TimeMode, now = new Date()): Exclude<TimeMode, "auto"> {
  return daylightFor(mode, now).lamps > 0 ? "day" : "night";
}

export function readTimeMode(): TimeMode {
  try {
    const saved = window.localStorage.getItem(MODE_KEY);
    return TIME_MODES.includes(saved as TimeMode) ? (saved as TimeMode) : "auto";
  } catch {
    return "auto";
  }
}

export function saveTimeMode(mode: TimeMode): void {
  try {
    window.localStorage.setItem(MODE_KEY, mode);
  } catch {
    // private window: the choice just lasts this visit
  }
}
