// One visual style for the whole market: the canvas (Scene.ts PALETTE, model.ts
// VENDOR) and the page (styles.css, via --abyss-* CSS variables) both read it.
export const THEME = {
  // the night harbour: page background, panels, lines
  bg0: "#091521",
  bg1: "#102333",
  bg2: "#142d3f",
  bgDeep: "#07111c",
  glow: "#244c62",
  line: "#223e4f",
  line2: "#294a5d",
  text: "#ecf4e8",
  textDim: "#b9ccd3",
  textSoft: "#d6e8e7",
  gold: "#f6d783",
  goldDeep: "#f0cb68",
  teal: "#85cfcc",
  // parchment dialogs
  parchment: "#fbf3de",
  parchmentDim: "#efe4c8",
  parchmentEdge: "#e2cfa4",
  ink: "#3b2412",
  inkText: "#2b1d0e",
  rust: "#7a3e12",
  brown: "#5a4630",
  brownSoft: "#7a6a52",
  ring: "#d9b36a",
  ringSoft: "#c9a86a",
  // canvas bits
  paper: "#fffdf6",
  cream: "#f3e6c8",
  inkDark: "#1b1b2f",
  muted: "#8d96a0",
  // meaning
  good: "#3fb950",
  goodSoft: "#77d982",
  warn: "#e0a82e",
  bad: "#e0473c",
  // task types and vendors (stall colours)
  research: "#4aa8e0",
  writing: "#e8a33d",
  checking: "#d0508a",
  vendorOpus: "#2f6fd6",
  vendorSonnet: "#d64545",
  vendorHaiku: "#8a4fd0",
} as const;

export const FONT_PIXEL = '"Silkscreen", monospace';
export const FONT_MONO = 'ui-monospace, "Cascadia Mono", Consolas, monospace';

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** Publish THEME as --abyss-* variables on :root (call once, before the first render). */
export function applyCssVars(root: HTMLElement = document.documentElement): void {
  for (const [name, value] of Object.entries(THEME)) root.style.setProperty(`--abyss-${kebab(name)}`, value);
  root.style.setProperty("--font-pixel", FONT_PIXEL);
  root.style.setProperty("--font-mono", FONT_MONO);
}
