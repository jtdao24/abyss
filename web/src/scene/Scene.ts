// The boardwalk market (web/public/art/boardwalk.png). The art has no people or
// text: vendors, the main agent, the reviewer and the player are sprites, and
// signs, bubbles and the HUD are drawn live in the art's own pixel coordinates.
// render(state) alone produces a correct picture; director.ts moves people.
import {
  Application,
  Assets,
  Container,
  Graphics,
  Rectangle,
  Sprite,
  Text,
  type FederatedPointerEvent,
  type Texture,
  type Ticker,
} from "pixi.js";

import type { AgentId, TaskType } from "../contract";
import type { MarketState } from "../state/reducer";
import { AGENT_ORDER, MAX_CARDS, VENDOR, sceneModel, type BubbleTone, type SceneModel } from "./model";
import {
  MAIN_AGENT_POS,
  PLAYER_START,
  REVIEWER_POS,
  STALLS,
  WORLD,
  hitTest,
  route,
  standable,
  type InteractId,
  type Interactable,
  type Point,
  type Rect,
} from "./world";

const FONT = ["Silkscreen", "monospace"];
const PEOPLE_SCALE = 0.46;
const PLAYER_SPEED = 260; // world px per second
const HEAD = 62;          // bubble height above a person's feet

export const PALETTE = {
  ink: "#1b1b2f",
  paper: "#fffdf6",
  cream: "#f3e6c8",
  gold: "#f0cb68",
  good: "#3fb950",
  ok: "#e0a82e",
  bad: "#e0473c",
  muted: "#8d96a0",
  research: "#4aa8e0",
  writing: "#e8a33d",
  checking: "#d0508a",
} as const;

export const SPENT_POS = { x: WORLD.w - 14, y: 16 };
/** The task list panel (click it to see every task). */
export const TASK_PANEL: Rect = [10, 36, 250, 36 + 20 + MAX_CARDS * 18];

const TYPE_COLOR: Record<TaskType, string> = {
  research: PALETTE.research,
  writing: PALETTE.writing,
  checking: PALETTE.checking,
};
const BUBBLE_TEXT: Record<BubbleTone, string> = {
  thinking: PALETTE.muted,
  bid: PALETTE.ink,
  pass: PALETTE.muted,
  won: "#8a5a00",
  working: "#1f5f8b",
  done: "#1d6b2a",
};
const CARD_FILL: Record<string, string> = {
  pending: "#6b5238",
  open: PALETTE.paper,
  assigned: PALETTE.paper,
  working: PALETTE.paper,
  done: "#dff3d8",
  graded: "#dff3d8",
  failed: "#f6d0cc",
};
const SPRITES = ["player", "main_agent", "reviewer", "vendor1", "vendor2", "vendor3"] as const;
const VENDOR_SPRITE: Record<AgentId, (typeof SPRITES)[number]> = { opus: "vendor1", sonnet: "vendor2", haiku: "vendor3" };

export function text(value: string, size: number, fill: string = PALETTE.paper): Text {
  const t = new Text({ text: value, style: { fontFamily: FONT, fontSize: size, fill } });
  t.anchor.set(0.5);
  return t;
}

/** A speech bubble: white box with an ink border and a tail pointing down to its position. */
class Bubble extends Container {
  private readonly bg = new Graphics();
  private readonly caption: Text;

  constructor(size = 13) {
    super();
    this.caption = text("", size, PALETTE.ink);
    this.addChild(this.bg, this.caption);
    this.visible = false;
  }

  set(value: string | null, color: string = PALETTE.ink, fill: string = PALETTE.paper): void {
    this.visible = value !== null;
    if (value === null) return;
    this.caption.text = value;
    this.caption.style.fill = color;
    const w = Math.max(34, Math.ceil(this.caption.width) + 16);
    const h = Math.ceil(this.caption.height) + 8;
    this.caption.position.set(0, -h / 2 - 8);
    this.bg.clear();
    this.bg.roundRect(-w / 2 - 2, -h - 10, w + 4, h + 4, 6).fill(PALETTE.ink);
    this.bg.roundRect(-w / 2, -h - 8, w, h, 5).fill(fill);
    this.bg.poly([-6, -10, 6, -10, 0, -1]).fill(PALETTE.ink);
    this.bg.poly([-3, -11, 3, -11, 0, -5]).fill(fill);
  }
}

export class MarketScene {
  readonly app: Application;
  readonly world = new Container();
  /** People, sorted by y so nearer ones overlap farther ones. */
  readonly actors = new Container();
  /** Effects layer for director.ts, above people and bubbles. */
  readonly fx = new Container();
  readonly vendors = {} as Record<AgentId, Sprite>;
  mainAgent!: Sprite;
  reviewer!: Sprite;
  player!: Sprite;
  /** Called when the player reaches something they clicked. */
  onInteract: (id: InteractId) => void = () => {};

  private readonly el: HTMLElement;
  private readonly vendorBubbles = {} as Record<AgentId, Bubble>;
  private readonly winnerFlags = {} as Record<AgentId, Graphics>;
  private readonly mainBubble = new Bubble(13);
  private readonly reviewBubble = new Bubble(15);
  private readonly cards: { bg: Graphics; label: Text; glyph: Text }[] = [];
  private banner!: Text;
  private spent!: Text;
  private finalBg!: Graphics;
  private finalText!: Text;
  private marker!: Text;
  private readonly hover = new Graphics();
  private hoverLabel!: Text;
  private hovered: Interactable | "tasks" | null = null;
  private readonly clickRing = new Graphics();
  private clickAge = Infinity;
  private walk: Point[] = [];
  private onArrive: (() => void) | null = null;
  private clock = 0;
  private lastModel = "";
  private resizeObserver: ResizeObserver | null = null;

  private constructor(el: HTMLElement, app: Application) {
    this.el = el;
    this.app = app;
  }

  static async create(el: HTMLElement): Promise<MarketScene> {
    await document.fonts.load('16px "Silkscreen"').catch(() => undefined);
    const app = new Application();
    await app.init({
      resizeTo: el,
      backgroundAlpha: 0,
      antialias: true,
      resolution: Math.min(2, window.devicePixelRatio || 1),
      autoDensity: true,
    });
    const backdrop = await Assets.load<Texture>("/art/boardwalk.png");
    const people = Object.fromEntries(
      await Promise.all(SPRITES.map(async (name) => [name, await Assets.load<Texture>(`/art/characters/${name}.png`)])),
    ) as Record<(typeof SPRITES)[number], Texture>;
    const scene = new MarketScene(el, app);
    scene.build(backdrop, people);
    el.appendChild(app.canvas);
    app.canvas.classList.add("market-canvas");
    scene.resizeObserver = new ResizeObserver(() => scene.fit());
    scene.resizeObserver.observe(el);
    scene.fit();
    return scene;
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
    this.app.ticker.remove(this.tick);
    this.app.destroy(true, { children: true });
  }

  /** Walk the player somewhere; `then` runs on arrival (a new click cancels it). */
  walkTo(target: Point, then: (() => void) | null = null): void {
    const dest = standable(target);
    this.walk = route({ x: this.player.x, y: this.player.y }, dest);
    this.onArrive = then;
  }

  private fit(): void {
    const { clientWidth: w, clientHeight: h } = this.el;
    if (!w || !h) return;
    this.app.renderer.resize(w, h);
    const scale = Math.min(w / WORLD.w, h / WORLD.h);
    this.world.scale.set(scale);
    this.world.position.set(Math.round((w - WORLD.w * scale) / 2), Math.round((h - WORLD.h * scale) / 2));
  }

  // ------------------------------------------------------------ build once
  private person(texture: Texture, at: Point): Sprite {
    const s = new Sprite(texture);
    s.anchor.set(0.5, 0.94); // feet on the point
    s.scale.set(PEOPLE_SCALE);
    s.position.set(at.x, at.y);
    this.actors.addChild(s);
    return s;
  }

  private build(backdrop: Texture, people: Record<(typeof SPRITES)[number], Texture>): void {
    this.app.stage.addChild(this.world);
    this.world.addChild(new Sprite(backdrop), this.clickRing, this.hover);

    for (const agentId of AGENT_ORDER) this.buildSign(agentId);

    this.actors.sortableChildren = true;
    this.mainAgent = this.person(people.main_agent, MAIN_AGENT_POS);
    this.reviewer = this.person(people.reviewer, REVIEWER_POS);
    for (const agentId of AGENT_ORDER) {
      this.vendors[agentId] = this.person(people[VENDOR_SPRITE[agentId]], STALLS[agentId].home);
    }
    this.player = this.person(people.player, PLAYER_START);
    this.world.addChild(this.actors);

    const bubbles = new Container();
    for (const agentId of AGENT_ORDER) {
      this.vendorBubbles[agentId] = new Bubble(13);
      bubbles.addChild(this.vendorBubbles[agentId]);
    }
    bubbles.addChild(this.mainBubble, this.reviewBubble);

    this.marker = text("!", 40, PALETTE.gold);
    this.marker.style.stroke = { color: PALETTE.ink, width: 6 };
    this.marker.visible = false;

    const hud = new Graphics().rect(0, 0, WORLD.w, 32).fill({ color: PALETTE.ink, alpha: 0.75 });
    this.banner = text("", 16);
    this.banner.anchor.set(0, 0.5);
    this.banner.position.set(12, 16);
    this.spent = text("", 16, PALETTE.gold);
    this.spent.anchor.set(1, 0.5);
    this.spent.position.set(SPENT_POS.x, SPENT_POS.y);
    this.finalBg = new Graphics();
    this.finalText = text("", 22, PALETTE.ink);
    this.finalText.position.set(WORLD.w / 2, 57);
    this.hoverLabel = text("", 14, PALETTE.paper);
    this.hoverLabel.style.stroke = { color: PALETTE.ink, width: 4 };
    this.hoverLabel.visible = false;

    const panel = this.buildTaskPanel();
    this.world.addChild(bubbles, this.marker, hud, this.banner, this.spent, panel, this.finalBg, this.finalText, this.fx, this.hoverLabel);

    this.world.eventMode = "static";
    this.world.hitArea = new Rectangle(0, 0, WORLD.w, WORLD.h);
    this.world.on("pointertap", (e: FederatedPointerEvent) => this.click(this.world.toLocal(e.global)));
    this.world.on("pointermove", (e: FederatedPointerEvent) => this.setHover(this.world.toLocal(e.global)));
    this.app.ticker.add(this.tick);
  }

  private buildSign(agentId: AgentId): void {
    const { sign } = STALLS[agentId];
    const name = text(VENDOR[agentId].name, 12, "#3b2412");
    name.position.set(sign.x, sign.y);
    const flag = new Graphics();
    flag.visible = false;
    flag.rect(sign.x + 48, sign.y - 32, 3, 40).fill(PALETTE.ink)
      .poly([sign.x + 51, sign.y - 30, sign.x + 51, sign.y - 10, sign.x + 72, sign.y - 20]).fill(PALETTE.gold);
    this.winnerFlags[agentId] = flag;
    this.world.addChild(name, flag);
  }

  private buildTaskPanel(): Container {
    const [x0, y0, x1, y1] = TASK_PANEL;
    const panel = new Container();
    const bg = new Graphics().roundRect(x0, y0, x1 - x0, y1 - y0, 6).fill({ color: PALETTE.ink, alpha: 0.72 });
    const title = text("TASKS", 12, PALETTE.gold);
    title.anchor.set(0, 0.5);
    title.position.set(x0 + 8, y0 + 10);
    panel.addChild(bg, title);
    for (let i = 0; i < MAX_CARDS; i += 1) {
      const y = y0 + 20 + i * 18;
      const card = { bg: new Graphics(), label: text("", 11, PALETTE.ink), glyph: text("", 11, PALETTE.ink) };
      card.label.anchor.set(0, 0.5);
      card.label.position.set(x0 + 16, y + 8);
      card.glyph.anchor.set(1, 0.5);
      card.glyph.position.set(x1 - 10, y + 8);
      panel.addChild(card.bg, card.label, card.glyph);
      this.cards.push(card);
    }
    return panel;
  }

  // ------------------------------------------------------------ input
  private click(p: Point): void {
    if (inPanel(p)) {
      this.onInteract("tasks");
      return;
    }
    const thing = hitTest(p);
    const dest = standable(thing ? thing.approach : p);
    this.walkTo(dest, thing ? () => this.onInteract(thing.id) : null);
    this.clickRing.position.set(dest.x, dest.y);
    this.clickAge = 0;
  }

  private setHover(p: Point): void {
    const thing = inPanel(p) ? "tasks" : hitTest(p);
    if (thing === this.hovered) return;
    this.hovered = thing;
    this.app.canvas.style.cursor = thing ? "pointer" : "default";
    this.hover.clear();
    this.hoverLabel.visible = thing !== null;
    if (!thing) return;
    const [x0, y0, x1, y1] = thing === "tasks" ? TASK_PANEL : thing.hit;
    this.hover.roundRect(x0, y0, x1 - x0, y1 - y0, 8).stroke({ width: 3, color: PALETTE.gold, alpha: 0.95 });
    this.hoverLabel.text = thing === "tasks" ? "SEE ALL TASKS" : thing.label;
    this.hoverLabel.position.set((x0 + x1) / 2, thing === "tasks" ? y1 + 12 : Math.max(46, y0 - 12));
  }

  // ------------------------------------------------------------ frame loop
  private readonly tick = (ticker: Ticker): void => {
    this.clock += ticker.deltaMS;
    this.stepPlayer(ticker.deltaMS);
    // bubbles follow their speakers; people overlap by depth
    for (const agentId of AGENT_ORDER) {
      const v = this.vendors[agentId];
      this.vendorBubbles[agentId].position.set(v.x, v.y - HEAD);
    }
    this.mainBubble.position.set(this.mainAgent.x, this.mainAgent.y - HEAD);
    this.reviewBubble.position.set(this.reviewer.x, this.reviewer.y - HEAD - 2);
    for (const child of this.actors.children) child.zIndex = child.y;
    if (this.marker.visible) {
      this.marker.position.set(this.mainAgent.x + 44, this.mainAgent.y - 70 - Math.abs(Math.sin(this.clock / 260)) * 10);
    }
    if (this.clickAge < 450) {
      this.clickAge += ticker.deltaMS;
      const p = Math.min(1, this.clickAge / 450);
      this.clickRing.clear().ellipse(0, 0, 10 + 12 * p, 4 + 5 * p).stroke({ width: 2, color: PALETTE.paper, alpha: 1 - p });
    }
  };

  private stepPlayer(deltaMs: number): void {
    const player = this.player;
    const target = this.walk[0];
    if (!target) {
      player.rotation = 0;
      return;
    }
    const dx = target.x - player.x;
    const dy = target.y - player.y;
    const dist = Math.hypot(dx, dy);
    const step = (PLAYER_SPEED * deltaMs) / 1000;
    if (dist <= step) {
      player.position.set(target.x, target.y);
      this.walk.shift();
      if (this.walk.length === 0) {
        player.rotation = 0;
        const arrive = this.onArrive;
        this.onArrive = null;
        arrive?.();
      }
      return;
    }
    player.x += (dx / dist) * step;
    player.y += (dy / dist) * step;
    if (Math.abs(dx) > 0.5) player.scale.x = (dx > 0 ? 1 : -1) * PEOPLE_SCALE;
    player.rotation = Math.sin(this.clock / 85) * 0.07;
  }

  // ------------------------------------------------------------ state -> picture
  private apply(model: SceneModel): void {
    this.banner.text = model.banner.length > 90 ? `${model.banner.slice(0, 87)}...` : model.banner;
    this.spent.text = model.spent;

    for (const agentId of AGENT_ORDER) {
      const stall = model.stalls.find((s) => s.agentId === agentId) ?? null;
      this.winnerFlags[agentId].visible = stall?.winner ?? false;
      const bubble = stall?.bubble ?? null;
      this.vendorBubbles[agentId].set(
        bubble?.text ?? null,
        bubble ? BUBBLE_TEXT[bubble.tone] : PALETTE.ink,
        bubble?.tone === "won" ? "#fff1c1" : PALETTE.paper,
      );
    }

    this.mainBubble.set(model.mainAgent);
    this.marker.visible = model.resultReady;

    if (model.reviewing) this.reviewBubble.set("...", PALETTE.muted);
    else if (model.review) {
      const grade = model.review.text.split(" ")[1];
      const tone = model.review.tone;
      const color = tone === "good" ? PALETTE.good : tone === "ok" ? "#9a6a00" : PALETTE.bad;
      this.reviewBubble.set(`${tone === "bad" ? "X" : "OK"} ${grade}`, color);
    } else this.reviewBubble.set(null);

    const [x0, y0, x1] = TASK_PANEL;
    this.cards.forEach((view, i) => {
      const card = model.cards[i];
      view.bg.clear();
      view.label.text = card?.label ?? "";
      view.glyph.text = card?.glyph ?? "";
      if (!card) return;
      const y = y0 + 20 + i * 18;
      if (card.current) view.bg.roundRect(x0 + 4, y - 1, x1 - x0 - 8, 18, 3).fill(PALETTE.gold);
      view.bg.roundRect(x0 + 6, y + 1, x1 - x0 - 12, 14, 2).fill(CARD_FILL[card.status] ?? PALETTE.paper);
      view.bg.rect(x0 + 6, y + 1, 4, 14).fill(TYPE_COLOR[card.type]);
      if (card.winnerColor) view.bg.rect(x0 + 10, y + 13, x1 - x0 - 16, 2).fill(card.winnerColor);
      view.label.style.fill = card.status === "pending" ? PALETTE.cream : PALETTE.ink;
      view.glyph.style.fill = card.status === "failed" ? PALETTE.bad : PALETTE.ink;
    });

    this.finalBg.clear();
    this.finalText.text = model.finalBanner ?? "";
    if (model.finalBanner) {
      const w = this.finalText.width + 30;
      this.finalBg.roundRect(WORLD.w / 2 - w / 2 - 3, 40, w + 6, 34, 7).fill(PALETTE.ink);
      this.finalBg.roundRect(WORLD.w / 2 - w / 2, 43, w, 28, 5).fill(PALETTE.gold);
    }
  }
}

function inPanel(p: Point): boolean {
  const [x0, y0, x1, y1] = TASK_PANEL;
  return p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
}
