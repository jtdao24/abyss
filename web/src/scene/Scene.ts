// The seaside market. Fully state-driven: render(state) alone produces the
// correct picture. Animations (director.ts) are decoration layered on top.
import {
  Application,
  Container,
  Graphics,
  Sprite,
  Text,
  TextureStyle,
  type Texture,
} from "pixi.js";

import type { AgentId, TaskType } from "../contract";
import type { MarketState } from "../state/reducer";
import {
  AGENT_ORDER,
  MAX_CARDS,
  TASK_TYPES,
  sceneModel,
  type BubbleTone,
  type SceneModel,
  type StallModel,
} from "./model";
import {
  COLORS,
  HARBOR_MASTER,
  HARBOR_PALETTE,
  KEEPER,
  TILL,
  TILL_PALETTE,
  keeperPalette,
  pixelTexture,
} from "./sprites";

export const WIDTH = 480;
export const HEIGHT = 270;
const HORIZON = 100;
const DECK_TOP = 150;
const DECK_BOTTOM = 205;
const EDGE = 212;
const FONT = "Silkscreen";

export const STALL_X: Record<AgentId, number> = { haiku: 155, sonnet: 250, opus: 345 };
export const LIGHTHOUSE_X = 444;
export const TILL_POS = { x: 100, y: 175 };
export const BOARD_POS = { x: 6, y: 44 };

const HAIR: Record<AgentId, string> = { haiku: "#2d2d2d", sonnet: "#8b4513", opus: "#e8e8e8" };
// Frozen in SPEC §1.1; used for keeper shirts so sprites are baked once.
const SHIRT: Record<AgentId, string> = { haiku: "#4fb3a9", sonnet: "#e8a33d", opus: "#8e6cc9" };
const BUBBLE_FILL: Record<BubbleTone, string> = {
  thinking: COLORS.cream,
  bid: COLORS.cream,
  pass: "#9aa3ad",
  won: COLORS.gold,
  working: "#a9dcf5",
  done: "#b8ecb0",
};
const TYPE_COLOR: Record<TaskType, string> = {
  research: COLORS.research,
  writing: COLORS.writing,
  checking: COLORS.checking,
};
const CARD_FILL: Record<string, string> = {
  pending: "#3a2c1c",
  open: COLORS.cream,
  assigned: COLORS.cream,
  working: COLORS.cream,
  done: "#d9f2d0",
  graded: "#d9f2d0",
  failed: "#f2c6c6",
};
const REVIEW_COLOR = { good: COLORS.good, ok: COLORS.ok, bad: COLORS.bad };

function text(value: string, fill: string = COLORS.text): Text {
  const t = new Text({ text: value, style: { fontFamily: [FONT, "monospace"], fontSize: 8, fill } });
  t.roundPixels = true;
  return t;
}

function box(g: Graphics, x: number, y: number, w: number, h: number, fill: string, border?: string): void {
  if (border) {
    g.rect(x, y, w, h).fill(border);
    g.rect(x + 1, y + 1, w - 2, h - 2).fill(fill);
  } else {
    g.rect(x, y, w, h).fill(fill);
  }
}

interface StallView {
  agentId: AgentId;
  cx: number;
  frame: Graphics;
  counter: Graphics;
  sign: Graphics;
  name: Text;
  flag: Graphics;
  bubbleBg: Graphics;
  bubbleText: Text;
  reps: Graphics;
  keeper: Sprite;
}

interface CardView {
  bg: Graphics;
  label: Text;
  glyph: Text;
}

export class MarketScene {
  readonly app: Application;
  /** Layer for director.ts animations, drawn above everything else. */
  readonly fx = new Container();
  private readonly el: HTMLElement;
  private readonly stalls = new Map<AgentId, StallView>();
  private readonly cards: CardView[] = [];
  private readonly textures: Texture[] = [];
  private banner!: Text;
  private spent!: Text;
  private reviewBg!: Graphics;
  private reviewText!: Text;
  private finalBg!: Graphics;
  private finalText!: Text;
  private shimmerA!: Graphics;
  private shimmerB!: Graphics;
  private resizeObserver: ResizeObserver | null = null;
  private lastModel = "";
  private scale = 1;

  private constructor(el: HTMLElement, app: Application) {
    this.el = el;
    this.app = app;
  }

  static async create(el: HTMLElement): Promise<MarketScene> {
    TextureStyle.defaultOptions.scaleMode = "nearest";
    // The font stylesheet is a <link> in index.html, so the face is declared by
    // now; load() fetches it. Pixi Text needs it before first render.
    await document.fonts.load(`8px "${FONT}"`).catch(() => undefined);
    const app = new Application();
    await app.init({
      width: WIDTH,
      height: HEIGHT,
      background: COLORS.skyTop,
      antialias: false,
      resolution: 1,
      roundPixels: true,
    });
    const scene = new MarketScene(el, app);
    scene.build();
    el.appendChild(app.canvas);
    app.canvas.classList.add("market-canvas");
    scene.resizeObserver = new ResizeObserver(() => scene.fit());
    scene.resizeObserver.observe(el);
    scene.fit();
    return scene;
  }

  /** Logical (480x270) → CSS pixel scale currently applied to the canvas. */
  get pixelScale(): number {
    return this.scale;
  }

  render(state: MarketState): void {
    const model = sceneModel(state);
    const key = JSON.stringify(model);
    if (key === this.lastModel) return;
    this.lastModel = key;
    this.apply(model);
  }

  destroy(): void {
    this.resizeObserver?.disconnect();
    this.app.destroy(true, { children: true });
    for (const texture of this.textures) texture.destroy(true);
  }

  private fit(): void {
    const { clientWidth: w, clientHeight: h } = this.el;
    if (!w || !h) return;
    const exact = Math.min(w / WIDTH, h / HEIGHT);
    // Integer scaling keeps pixels uniform; below 2x that wastes too much of
    // the stage, so fill it and accept slightly uneven pixels.
    this.scale = exact >= 2 ? Math.floor(exact) : exact;
    this.app.canvas.style.width = `${Math.round(WIDTH * this.scale)}px`;
    this.app.canvas.style.height = `${Math.round(HEIGHT * this.scale)}px`;
  }

  // ------------------------------------------------------------ static world
  private build(): void {
    const stage = this.app.stage;
    stage.addChild(this.buildBackdrop());
    stage.addChild(this.buildBoard());
    stage.addChild(this.buildLighthouse());
    for (const agentId of AGENT_ORDER) stage.addChild(this.buildStall(agentId));

    const master = new Sprite(this.texture(HARBOR_MASTER, HARBOR_PALETTE));
    master.scale.set(2);
    master.position.set(94, DECK_TOP - 20);
    const till = new Sprite(this.texture(TILL, TILL_PALETTE));
    till.scale.set(2);
    till.position.set(TILL_POS.x, TILL_POS.y);
    stage.addChild(master, till);

    const hud = new Graphics();
    hud.rect(0, 0, WIDTH, 14).fill({ color: COLORS.ink, alpha: 0.75 });
    this.banner = text("");
    this.banner.position.set(4, 2);
    this.spent = text("", COLORS.gold);
    this.spent.anchor.set(1, 0);
    this.spent.position.set(WIDTH - 4, 2);
    this.finalBg = new Graphics();
    this.finalText = text("", COLORS.ink);
    this.finalText.anchor.set(0.5, 0);
    this.finalText.position.set(WIDTH / 2, 18);
    stage.addChild(hud, this.banner, this.spent, this.finalBg, this.finalText, this.fx);

    this.app.ticker.add(this.shimmer);
  }

  private texture(rows: string[], palette: Record<string, string>): Texture {
    const t = pixelTexture(this.app.renderer, rows, palette);
    this.textures.push(t);
    return t;
  }

  private buildBackdrop(): Container {
    const layer = new Container();
    const g = new Graphics();
    const bands = [COLORS.skyTop, COLORS.skyMid, COLORS.skyLow, COLORS.horizon];
    const bandH = HORIZON / bands.length;
    bands.forEach((c, i) => g.rect(0, Math.round(i * bandH), WIDTH, Math.ceil(bandH)).fill(c));
    g.rect(226, HORIZON - 12, 48, 12).fill(COLORS.sun);
    g.rect(232, HORIZON - 16, 36, 4).fill(COLORS.sun);
    g.rect(240, HORIZON - 18, 20, 2).fill(COLORS.sun);
    g.rect(0, HORIZON, WIDTH, DECK_TOP - HORIZON).fill(COLORS.seaBack);
    // deck planks
    for (let y = DECK_TOP, row = 0; y < DECK_BOTTOM; y += 5, row += 1) {
      g.rect(0, y, WIDTH, 5).fill(row % 2 ? COLORS.plankAlt : COLORS.plank);
      g.rect(0, y + 4, WIDTH, 1).fill(COLORS.seam);
      for (let x = (row % 3) * 11; x < WIDTH; x += 33) g.rect(x, y, 1, 4).fill(COLORS.seam);
    }
    g.rect(0, DECK_BOTTOM, WIDTH, EDGE - DECK_BOTTOM).fill(COLORS.beam);
    g.rect(0, EDGE, WIDTH, HEIGHT - EDGE).fill(COLORS.seaFront);
    for (let x = 14; x < WIDTH; x += 44) g.rect(x, EDGE, 5, 22).fill(COLORS.beam);
    layer.addChild(g);

    this.shimmerA = new Graphics();
    this.shimmerB = new Graphics();
    for (let i = 0; i < 26; i += 1) {
      const x = (i * 97) % WIDTH;
      const back = HORIZON + 4 + ((i * 13) % (DECK_TOP - HORIZON - 8));
      const front = EDGE + 26 + ((i * 7) % (HEIGHT - EDGE - 30));
      this.shimmerA.rect(x, back, 6, 1).rect(x + 20, front, 8, 1).fill(COLORS.shimmer);
      this.shimmerB.rect(x + 9, back + 2, 5, 1).rect(x + 31, front + 2, 7, 1).fill(COLORS.shimmer);
    }
    this.shimmerB.visible = false;
    layer.addChild(this.shimmerA, this.shimmerB);
    return layer;
  }

  private buildBoard(): Container {
    const layer = new Container();
    const { x, y } = BOARD_POS;
    const g = new Graphics();
    g.rect(x + 8, y + 88, 4, DECK_TOP + 12 - (y + 88)).fill(COLORS.corkEdge);
    g.rect(x + 74, y + 88, 4, DECK_TOP + 12 - (y + 88)).fill(COLORS.corkEdge);
    box(g, x, y, 86, 90, COLORS.cork, COLORS.corkEdge);
    g.rect(x + 1, y + 1, 84, 12).fill(COLORS.corkEdge);
    const title = text("TASKS", COLORS.gold);
    title.position.set(x + 4, y + 2);
    layer.addChild(g, title);
    for (let i = 0; i < MAX_CARDS; i += 1) {
      const card: CardView = { bg: new Graphics(), label: text(""), glyph: text("") };
      card.label.position.set(x + 9, y + 17 + i * 14);
      card.glyph.anchor.set(1, 0);
      card.glyph.position.set(x + 81, y + 17 + i * 14);
      layer.addChild(card.bg, card.label, card.glyph);
      this.cards.push(card);
    }
    return layer;
  }

  private buildLighthouse(): Container {
    const layer = new Container();
    const g = new Graphics();
    const cx = LIGHTHOUSE_X;
    g.rect(cx - 26, DECK_TOP - 6, 52, DECK_BOTTOM - DECK_TOP + 6).fill("#5b5f6b");
    g.rect(cx - 22, DECK_TOP - 10, 44, 6).fill("#6e7380");
    for (let y = 40; y < DECK_TOP - 6; y += 1) {
      const half = Math.round(9 + ((y - 40) / (DECK_TOP - 46)) * 5);
      const stripe = Math.floor((y - 40) / 14) % 2 === 0 ? "#f3efe6" : "#c0392b";
      g.rect(cx - half, y, half * 2, 1).fill(stripe);
    }
    g.circle(cx, 33, 16).fill({ color: "#fff3b0", alpha: 0.18 });
    g.rect(cx - 10, 26, 20, 14).fill(COLORS.ink);
    g.rect(cx - 7, 28, 14, 10).fill("#fff3b0");
    g.rect(cx - 12, 39, 24, 2).fill(COLORS.ink);
    for (let i = 0; i < 8; i += 1) g.rect(cx - i - 1, 18 + i, (i + 1) * 2, 1).fill("#c0392b");
    const label = text("REVIEW", COLORS.cream);
    label.anchor.set(0.5, 0);
    label.position.set(cx, DECK_TOP + 8);
    this.reviewBg = new Graphics();
    this.reviewText = text("");
    this.reviewText.anchor.set(0.5, 0);
    this.reviewText.position.set(404, 86);
    layer.addChild(g, label, this.reviewBg, this.reviewText);
    return layer;
  }

  private buildStall(agentId: AgentId): Container {
    const layer = new Container();
    const cx = STALL_X[agentId];
    const keeper = new Sprite(this.texture(KEEPER, keeperPalette(SHIRT[agentId], HAIR[agentId])));
    keeper.scale.set(2);
    keeper.position.set(cx - 10, 102);
    const view: StallView = {
      agentId,
      cx,
      frame: new Graphics(),
      counter: new Graphics(),
      sign: new Graphics(),
      name: text(""),
      flag: new Graphics(),
      bubbleBg: new Graphics(),
      bubbleText: text("", COLORS.ink),
      reps: new Graphics(),
      keeper,
    };
    view.name.anchor.set(0.5, 0);
    view.name.position.set(cx, 49);
    view.bubbleText.anchor.set(0.5, 0);
    view.bubbleText.position.set(cx, 28);
    layer.addChild(
      view.frame, keeper, view.counter, view.reps, view.sign, view.name, view.flag, view.bubbleBg, view.bubbleText,
    );
    for (const [i, type] of TASK_TYPES.entries()) {
      const letter = text(type[0].toUpperCase(), COLORS.cream);
      letter.position.set(cx - 27, 127 + i * 7);
      layer.addChild(letter);
    }
    this.stalls.set(agentId, view);
    return layer;
  }

  // ------------------------------------------------------------ state → picture
  private apply(model: SceneModel): void {
    this.banner.text = model.banner.length > 62 ? `${model.banner.slice(0, 59)}...` : model.banner;
    this.spent.text = model.spent;

    for (const agentId of AGENT_ORDER) {
      const view = this.stalls.get(agentId)!;
      const stall = model.stalls.find((s) => s.agentId === agentId);
      this.drawStall(view, stall ?? null);
    }

    model.cards.forEach((card, i) => {
      const view = this.cards[i];
      const { x, y } = BOARD_POS;
      const top = y + 16 + i * 14;
      view.bg.clear();
      if (card.current) view.bg.rect(x + 3, top - 1, 80, 14).fill(COLORS.gold);
      box(view.bg, x + 4, top, 78, 12, CARD_FILL[card.status] ?? COLORS.cream);
      view.bg.rect(x + 4, top, 3, 12).fill(TYPE_COLOR[card.type]);
      if (card.winnerColor) view.bg.rect(x + 7, top + 10, 75, 2).fill(card.winnerColor);
      const ink = card.status === "pending" ? COLORS.dim : COLORS.ink;
      view.label.text = card.label;
      view.label.style.fill = ink;
      view.glyph.text = card.glyph;
      view.glyph.style.fill = card.status === "failed" ? COLORS.bad : ink;
    });
    for (let i = model.cards.length; i < MAX_CARDS; i += 1) {
      this.cards[i].bg.clear();
      this.cards[i].label.text = "";
      this.cards[i].glyph.text = "";
    }

    this.reviewBg.clear();
    this.reviewText.text = model.review?.text ?? "";
    if (model.review) {
      const w = Math.ceil(this.reviewText.width) + 8;
      box(this.reviewBg, 404 - Math.ceil(w / 2), 84, w, 12, REVIEW_COLOR[model.review.tone], COLORS.ink);
      this.reviewText.style.fill = COLORS.ink;
    }

    this.finalBg.clear();
    this.finalText.text = model.finalBanner ?? "";
    if (model.finalBanner) {
      const w = Math.ceil(this.finalText.width) + 12;
      box(this.finalBg, Math.round(WIDTH / 2 - w / 2), 16, w, 12, COLORS.gold, COLORS.ink);
    }
  }

  private drawStall(view: StallView, stall: StallModel | null): void {
    const { cx, frame, counter } = view;
    const color = stall?.color ?? "#777777";

    frame.clear();
    frame.rect(cx - 33, 76, 3, DECK_TOP + 8 - 76).fill(COLORS.beam);
    frame.rect(cx + 30, 76, 3, DECK_TOP + 8 - 76).fill(COLORS.beam);
    for (let i = 0; i < 10; i += 1) {
      const x = cx - 35 + i * 7;
      frame.rect(x, 60, 7, 16).fill(i % 2 ? COLORS.cream : color);
      frame.rect(x + 1, 76, 5, 2).fill(i % 2 ? COLORS.cream : color);
    }
    frame.rect(cx - 35, 60, 70, 1).fill(COLORS.ink);

    counter.clear();
    box(counter, cx - 31, 124, 62, 26, "#8a5a33", "#3b2412");
    counter.rect(cx - 30, 124, 60, 2).fill("#a8744a");

    view.reps.clear();
    TASK_TYPES.forEach((type, i) => {
      const y = 129 + i * 7;
      view.reps.rect(cx - 20, y, 46, 4).fill("#2a1a0e");
      const rep = stall?.reputation[type] ?? 1;
      const w = Math.max(0, Math.min(46, Math.round((rep / 2) * 46)));
      view.reps.rect(cx - 20, y, w, 4).fill(TYPE_COLOR[type]);
      view.reps.rect(cx + 3, y - 1, 1, 6).fill(COLORS.cream); // 1.0 tick
    });

    view.sign.clear();
    box(view.sign, cx - 33, 47, 66, 12, COLORS.ink, stall?.winner ? COLORS.gold : color);
    view.name.text = stall?.name ?? "";

    view.flag.clear();
    if (stall?.winner) {
      view.flag.rect(cx + 34, 36, 1, 24).fill(COLORS.cream);
      for (let i = 0; i < 6; i += 1) view.flag.rect(cx + 35, 37 + i, 10 - i * 2, 1).fill(COLORS.gold);
    }

    view.bubbleBg.clear();
    view.bubbleText.text = stall?.bubble?.text ?? "";
    if (stall?.bubble) {
      const w = Math.ceil(view.bubbleText.width) + 8;
      box(view.bubbleBg, cx - Math.ceil(w / 2), 26, w, 12, BUBBLE_FILL[stall.bubble.tone], COLORS.ink);
      view.bubbleBg.rect(cx - 1, 38, 3, 2).fill(COLORS.ink);
    }
  }

  private shimmerElapsed = 0;
  private readonly shimmer = (ticker: { deltaMS: number }): void => {
    this.shimmerElapsed += ticker.deltaMS;
    if (this.shimmerElapsed < 600) return;
    this.shimmerElapsed = 0;
    this.shimmerA.visible = !this.shimmerA.visible;
    this.shimmerB.visible = !this.shimmerB.visible;
  };
}
