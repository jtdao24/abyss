// Pixel-art sprites as string rows. Each character maps to a palette color;
// "." is transparent. Turned into textures once at scene creation.
import { Graphics, Rectangle, type Renderer, type Texture } from "pixi.js";

export type Palette = Record<string, string>;

export const COLORS = {
  skyTop: "#1b2a49",
  skyMid: "#3b4f7a",
  skyLow: "#6b6fa8",
  horizon: "#e7a977",
  sun: "#f4c46a",
  seaBack: "#2e5e82",
  seaFront: "#173f5f",
  shimmer: "#8fc1e0",
  plank: "#7a5230",
  plankAlt: "#6b4628",
  seam: "#54361e",
  beam: "#4a2f19",
  cream: "#f3e6c8",
  cork: "#b98b52",
  corkEdge: "#5b3a1e",
  ink: "#1a1a2e",
  gold: "#f0cb68",
  good: "#77d982",
  ok: "#f0cb68",
  bad: "#e0625a",
  text: "#fdf6e3",
  dim: "#a58c6a",
  research: "#7fd1ff",
  writing: "#ffd36b",
  checking: "#ff8fa3",
} as const;

const SKIN = "#f1c27d";

// 10x12 market keeper; "c" is the shirt (agent color), "h" hair.
export const KEEPER = [
  "...hhhh...",
  "..hhhhhh..",
  "..ssssss..",
  "..sesses..",
  "..ssssss..",
  "...smms...",
  "..cccccc..",
  ".cccccccc.",
  ".sccccccs.",
  ".sccccccs.",
  "..cccccc..",
  "..cc..cc..",
];

// 10x14 harbor master (the orchestrator) with a captain's cap.
export const HARBOR_MASTER = [
  "..kkkkkk..",
  ".kkggkkkk.",
  "..ssssss..",
  "..sesses..",
  "..ssssss..",
  "...smms...",
  "..bbbbbb..",
  ".bbbgbbbb.",
  ".sbbgbbbs.",
  ".sbbbbbbs.",
  "..bbbbbb..",
  "..bb..bb..",
  "..bb..bb..",
  "..kk..kk..",
];

// 12x8 coin chest (the till).
export const TILL = [
  "..gggggggg..",
  ".gwwwwwwwwg.",
  "gwyyyyyyyywg",
  "gwwwwkkwwwwg",
  "gwwwwkkwwwwg",
  "gwwwwwwwwwwg",
  "gwwwwwwwwwwg",
  ".gggggggggg.",
];

export function keeperPalette(shirt: string, hair: string): Palette {
  return { h: hair, s: SKIN, e: COLORS.ink, m: "#b5523b", c: shirt };
}

export const HARBOR_PALETTE: Palette = {
  k: "#22313f", g: COLORS.gold, s: SKIN, e: COLORS.ink, m: "#b5523b", b: "#1d3557",
};

export const TILL_PALETTE: Palette = {
  g: "#3b2412", w: "#8a5a33", y: COLORS.gold, k: COLORS.ink,
};

export function pixelTexture(renderer: Renderer, rows: string[], palette: Palette): Texture {
  const g = new Graphics();
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) {
      const color = palette[row[x]];
      if (color) g.rect(x, y, 1, 1).fill(color);
    }
  });
  const texture = renderer.generateTexture({
    target: g,
    frame: new Rectangle(0, 0, rows[0].length, rows.length),
    resolution: 1,
  });
  g.destroy();
  return texture;
}
