/** How much of the art the camera may crop to fill the stage (0.25 = 25%). */
export const MAX_CROP = 0.25;

/**
 * Fit the art (W x H) into a stage (w x h): cover it (no black bars) but never
 * crop more than MAX_CROP of the art on either axis, centred. Returns null for
 * an empty stage (a minimized window), which callers must skip.
 */
export function fitScale(w: number, h: number, W: number, H: number): { scale: number; x: number; y: number } | null {
  if (!w || !h || w <= 0 || h <= 0) return null;
  const contain = Math.min(w / W, h / H);
  const cover = Math.max(w / W, h / H);
  const scale = Math.min(cover, contain / (1 - MAX_CROP));
  return { scale, x: Math.round((w - W * scale) / 2), y: Math.round((h - H * scale) / 2) };
}
