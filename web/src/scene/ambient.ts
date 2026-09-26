// Ambient life for the painted backdrop: rippling water, foliage swaying in the
// wind, glints on the sea, flickering lanterns and the odd drifting leaf. The
// masks and spots come from web/scripts/make_ambient.py.
import { Container, DisplacementFilter, Graphics, Sprite, Texture, type Ticker } from "pixi.js";

export interface AmbientData {
  glints: [number, number][];
  lanterns: [number, number][];
}

const GLINTS_AT_ONCE = 14;
const LEAF_EVERY_MS = 2600;

/** A tileable noise texture for displacement: red drives x, green drives y. */
function noiseTexture(size = 256): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(size, size);
  const tau = (Math.PI * 2) / size;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      // sums of whole-period sines tile seamlessly
      const r = Math.sin(x * tau * 2 + Math.sin(y * tau * 3) * 1.4) + 0.5 * Math.sin(y * tau * 5 + x * tau);
      const g = Math.sin(y * tau * 2 + Math.sin(x * tau * 3) * 1.4) + 0.5 * Math.sin(x * tau * 4 - y * tau);
      const i = (y * size + x) * 4;
      img.data[i] = 128 + r * 80;
      img.data[i + 1] = 128 + g * 80;
      img.data[i + 2] = 128;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const texture = Texture.from(canvas);
  texture.source.addressMode = "repeat";
  return texture;
}

/** A copy of the backdrop, shown only through `mask`, distorted by moving noise. */
function distorted(backdrop: Texture, mask: Texture, noise: Texture, scale: { x: number; y: number }) {
  const layer = new Container();
  const art = new Sprite(backdrop);
  const maskSprite = new Sprite(mask);
  const map = new Sprite(noise);
  map.renderable = false; // only drives the filter
  art.filters = [new DisplacementFilter({ sprite: map, scale })];
  art.mask = maskSprite;
  layer.addChild(map, art, maskSprite);
  return { layer, map };
}

interface Glint { g: Graphics; age: number; life: number }
interface Leaf { g: Graphics; age: number; life: number; x0: number; y0: number; drift: number }

export class Ambient {
  readonly back = new Container();  // water + foliage, right above the backdrop
  readonly front = new Container(); // glints, glows, leaves, above the planks
  private readonly waterMap: Sprite;
  private readonly foliageMap: Sprite;
  private readonly glints: Glint[] = [];
  private readonly glows: { g: Graphics; phase: number }[] = [];
  private readonly leaves: Leaf[] = [];
  private clock = 0;
  private leafClock = 0;

  constructor(
    backdrop: Texture,
    water: Texture,
    foliage: Texture,
    private readonly data: AmbientData,
    private readonly width: number,
    ripples = true,
  ) {
    const noise = noiseTexture();
    const w = distorted(backdrop, water, noise, { x: 7, y: 4 });
    const f = distorted(backdrop, foliage, noise, { x: 5, y: 1.5 });
    this.waterMap = w.map;
    this.foliageMap = f.map;
    this.foliageMap.scale.set(1.5);
    if (ripples) this.back.addChild(w.layer, f.layer);

    for (const [x, y] of data.lanterns) {
      const g = new Graphics().circle(0, 0, 18).fill({ color: "#ffb347", alpha: 0.35 }).circle(0, 0, 9).fill({ color: "#ffe29a", alpha: 0.4 });
      g.blendMode = "add";
      g.position.set(x, y);
      this.front.addChild(g);
      this.glows.push({ g, phase: Math.random() * 10 });
    }
  }

  update(ticker: Ticker): void {
    const dt = ticker.deltaMS;
    this.clock += dt;
    // water flows one way, the wind pushes the leaves back and forth
    this.waterMap.x += dt * 0.012;
    this.waterMap.y += dt * 0.006;
    this.foliageMap.x = Math.sin(this.clock / 1400) * 40;
    this.foliageMap.y += dt * 0.004;

    for (const { g, phase } of this.glows) {
      const flicker = 0.75 + 0.15 * Math.sin(this.clock / 170 + phase) + 0.1 * Math.sin(this.clock / 53 + phase * 3);
      g.alpha = flicker;
      g.scale.set(0.95 + 0.08 * Math.sin(this.clock / 400 + phase));
    }

    while (this.glints.length < GLINTS_AT_ONCE) this.spawnGlint();
    for (let i = this.glints.length - 1; i >= 0; i -= 1) {
      const glint = this.glints[i];
      glint.age += dt;
      const p = glint.age / glint.life;
      glint.g.alpha = Math.sin(Math.min(1, p) * Math.PI);
      if (p >= 1) {
        glint.g.destroy();
        this.glints.splice(i, 1);
      }
    }

    this.leafClock += dt;
    if (this.leafClock > LEAF_EVERY_MS) {
      this.leafClock = 0;
      this.spawnLeaf();
    }
    for (let i = this.leaves.length - 1; i >= 0; i -= 1) {
      const leaf = this.leaves[i];
      leaf.age += dt;
      const p = leaf.age / leaf.life;
      leaf.g.x = leaf.x0 + p * (this.width + 120);
      leaf.g.y = leaf.y0 + p * leaf.drift + Math.sin(leaf.age / 350) * 18;
      leaf.g.rotation = Math.sin(leaf.age / 280) * 1.2;
      leaf.g.alpha = p < 0.1 ? p * 10 : p > 0.9 ? (1 - p) * 10 : 1;
      if (p >= 1) {
        leaf.g.destroy();
        this.leaves.splice(i, 1);
      }
    }
  }

  private spawnGlint(): void {
    const [x, y] = this.data.glints[Math.floor(Math.random() * this.data.glints.length)];
    const s = 2 + Math.random() * 2.5;
    const g = new Graphics().poly([0, -s * 2, s * 0.6, 0, 0, s * 2, -s * 0.6, 0]).fill("#ffffff")
      .poly([-s * 2, 0, 0, s * 0.6, s * 2, 0, 0, -s * 0.6]).fill("#ffffff");
    g.position.set(x, y);
    g.alpha = 0;
    this.front.addChild(g);
    this.glints.push({ g, age: 0, life: 700 + Math.random() * 900 });
  }

  private spawnLeaf(): void {
    const g = new Graphics().ellipse(0, 0, 7, 3).fill("#5fa832").rect(-7, -0.5, 14, 1).fill("#3d7a1e");
    const y0 = 60 + Math.random() * 380;
    g.position.set(-60, y0);
    this.front.addChild(g);
    this.leaves.push({ g, age: 0, life: 9000 + Math.random() * 5000, x0: -60, y0, drift: 60 + Math.random() * 120 });
  }
}
