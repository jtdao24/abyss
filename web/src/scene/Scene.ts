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
  UPDATE_PRIORITY,
  type FederatedPointerEvent,
  type Texture,
  type Ticker,
} from "pixi.js";

import { sfx } from "../audio/sfx";
import type { AgentId, TaskType } from "../contract";
import { Ambient, type AmbientData } from "./ambient";
import { fitScale } from "./fit";
import { THEME } from "../theme";
import type { MarketState } from "../state/reducer";
import { AGENT_ORDER, MAX_CARDS, VENDOR, sceneModel, type BubbleTone, type SceneModel, type StallModel } from "./model";
import {
  MAIN_AGENT_POS,
  PLAYER_START,
  REVIEWER_POS,
  STALLS,
  WORLD,
  focusRect,
  hitTest,
  route,
  standable,
  walkable,
  type InteractId,
  type Interactable,
  type Point,
  type Rect,
} from "./world";

const FONT = ["Silkscreen", "monospace"];
const PEOPLE_SCALE = 0.55;
const PLAYER_SPEED = 280; // world px per second
const MOVE_KEYS: Record<string, "up" | "down" | "left" | "right"> = {
  w: "up", arrowup: "up", s: "down", arrowdown: "down",
  a: "left", arrowleft: "left", d: "right", arrowright: "right",
};
const HEAD = 84;          // bubble height above a person's feet
const MAX_ZOOM = 3;       // focus never zooms past this multiple of the fitted view
const PANEL_SHARE = 0.42; // bottom share of the stage covered by the focus panel
/** ?calm=1 turns off the rippling water and swaying leaves (for slow machines). */
/** Also on when the system asks for less motion. */
const CALM =
  new URLSearchParams(window.location.search).get("calm") === "1" ||
  (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

export const PALETTE = {
  ink: THEME.inkDark,
  paper: THEME.paper,
  cream: THEME.cream,
  gold: THEME.goldDeep,
  good: THEME.good,
  ok: THEME.warn,
  bad: THEME.bad,
  muted: THEME.muted,
  research: THEME.research,
  writing: THEME.writing,
  checking: THEME.checking,
} as const;

export const SPENT_POS = { x: WORLD.w - 14, y: 16 };
/** The task list panel (click it to see every task). */
export const TASK_PANEL: Rect = [10, 36, 250, 36 + 20 + MAX_CARDS * 18];

const TYPE_COLOR: Record<TaskType, string> = {
  research: PALETTE.research,
  writing: PALETTE.writing,
  checking: PALETTE.checking,
};
/** What a vendor is visibly doing with a task it won (director.ts plays it out). */
export type VendorStage = "none" | "won" | "working" | "done";
const WINNER_TONES = new Set<BubbleTone>(["won", "working", "done"]);
const STAGE_BUBBLE: Record<Exclude<VendorStage, "none">, NonNullable<StallModel["bubble"]>> = {
  won: { text: "WON!", tone: "won" },
  working: { text: "WORKING", tone: "working" },
  done: { text: "DONE", tone: "done" },
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
  /** Called when the player clicks open ground (not a person or stall). */
  onGround: () => void = () => {};

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
  private readonly hover = new Graphics();
  private hoverLabel!: Text;
  private hovered: Interactable | "tasks" | null = null;
  /** The latest pointer position, handled once per frame (pointermove fires far more often). */
  private pendingHover: Point | null = null;
  private readonly clickRing = new Graphics();
  private clickAge = Infinity;
  private walk: Point[] = [];
  private onArrive: (() => void) | null = null;
  /** Movement keys held down right now (WASD / arrows). */
  private readonly keys = new Set<string>();
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    const key = MOVE_KEYS[e.key.toLowerCase()];
    // never steal keys from the terminal or any other text box
    const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));
    if (!key || typing || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    this.keys.add(key);
  };
  private readonly onKeyUp = (e: KeyboardEvent): void => {
    const key = MOVE_KEYS[e.key.toLowerCase()];
    if (key) this.keys.delete(key);
  };
  private readonly onBlur = (): void => this.keys.clear();
  private clock = 0;
  /** Walking time since the player's last footstep sound. */
  private stepMs = 0;
  private lastModel = "";
  private model: SceneModel | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private ambient!: Ambient;
  /** Camera: the fitted view, where it is heading, and where it is now. */
  private base = { scale: 1, x: 0, y: 0 };
  private camTarget = { scale: 1, x: 0, y: 0 };
  private cam = { scale: 1, x: 0, y: 0 };
  private focused: InteractId | null = null;
  private watchdog: number | null = null;

  private constructor(el: HTMLElement, app: Application) {
    this.el = el;
    this.app = app;
  }

  static async create(el: HTMLElement): Promise<MarketScene> {
    await document.fonts.load('16px "Silkscreen"').catch(() => undefined);
    const app = new Application();
    await app.init({
      backgroundAlpha: 0,
      antialias: false,
      roundPixels: true,
      resolution: Math.min(2, window.devicePixelRatio || 1),
      autoDensity: true,
    });
    const [backdrop, water, foliage, ambient] = await Promise.all([
      Assets.load<Texture>("/art/boardwalk.png"),
      Assets.load<Texture>("/art/boardwalk_water.png"),
      Assets.load<Texture>("/art/boardwalk_foliage.png"),
      fetch("/art/boardwalk_ambient.json").then((r) => r.json() as Promise<AmbientData>),
    ]);
    const people = Object.fromEntries(
      await Promise.all(SPRITES.map(async (name) => [name, await Assets.load<Texture>(`/art/characters/${name}.png`)])),
    ) as Record<(typeof SPRITES)[number], Texture>;
    // Keep motion in real time on slow machines: let a frame cover up to 250ms
    // (Pixi's default caps it at 100ms, which makes everyone crawl below 10fps).
    app.ticker.minFPS = 4;
    const scene = new MarketScene(el, app);
    // Draw each frame inside a guard. Pixi only schedules the next frame once
    // this one returns, so one throw froze the scene for good; a throw can also
    // leave its filter stack half pushed, failing every later frame right after
    // the backdrop. Reset that, turn the ripples off, and keep drawing.
    app.ticker.remove(app.render, app);
    let failures = 0;
    app.ticker.add(
      () => {
        try {
          app.render();
        } catch (error) {
          failures += 1;
          if (failures === 1) console.warn("A frame failed to render; ripples are now off", error);
          try {
            const filters = (app.renderer as unknown as { filter?: { _filterStackIndex: number } }).filter;
            if (filters) filters._filterStackIndex = 0;
          } catch {
            /* private Pixi field; the next frame starts clean anyway */
          }
          scene.ambient?.disableEffects();
        }
      },
      undefined,
      UPDATE_PRIORITY.LOW,
    );
    scene.ambient = new Ambient(backdrop, water, foliage, ambient, WORLD.w, !CALM);
    scene.build(backdrop, people);
    el.appendChild(app.canvas);
    app.canvas.classList.add("market-canvas");
    app.canvas.setAttribute("role", "img");
    app.canvas.setAttribute(
      "aria-label",
      "The boardwalk market: the Captain on the boat, three vendor stalls and the lifeguard. Use the Captain button or the list of people to open their panels.",
    );
    scene.resizeObserver = new ResizeObserver(() => scene.fit());
    scene.resizeObserver.observe(el);
    scene.fit();
    scene.startWatchdog();
    return scene;
  }

  render(state: MarketState): void {
    const model = sceneModel(state);
    const key = JSON.stringify(model);
    if (key === this.lastModel) return;
    this.lastModel = key;
    this.model = model;
    this.apply(model);
  }

  /**
   * Set by director.ts: what a vendor is visibly doing, so WON! / WORKING / DONE
   * appear when the animation gets there, not when the event arrives.
   * Without a director, bubbles follow the state alone.
   */
  stageOf: ((agentId: AgentId) => VendorStage) | null = null;
  /** Set by director.ts: true while finished work is still on its way to the reviewer. */
  handOverPending: (() => boolean) | null = null;

  /** Re-draw the bubbles after the director's picture of things changes. */
  refreshBubbles(): void {
    if (this.model) this.apply(this.model);
  }

  destroy(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    this.stopWatchdog();
    this.resizeObserver?.disconnect();
    this.app.ticker.remove(this.tick);
    // The ripples own canvas textures and filters Pixi doesn't know to free:
    // unbind them first, or Pixi warns about textures destroyed while bound.
    this.ambient?.destroy();
    // Leave the loaded art alone: the backdrop and characters come from Pixi's
    // Assets cache and are shared with the next scene. (React's dev mode mounts
    // the page twice, so destroying them here left the second scene black.)
    this.app.destroy(true, { children: true });
  }

  /** Walk the player somewhere; `then` runs on arrival (a new click cancels it). */
  walkTo(target: Point, then: (() => void) | null = null): void {
    const dest = standable(target);
    this.walk = route({ x: this.player.x, y: this.player.y }, dest);
    this.onArrive = then;
  }

  /** Zoom the camera onto a person or stall (null zooms back out). */
  focus(id: InteractId | null): void {
    this.focused = id;
    this.camTarget = this.cameraFor(id);
  }

  /**
   * Keeps the render loop alive: if no frame has run for a while although the
   * page is visible (e.g. after a minimize), restart the loop and refit.
   */
  private startWatchdog(): void {
    let lastSeen = this.app.ticker.lastTime;
    let stalledSince = performance.now();
    this.watchdog = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      const now = performance.now();
      if (this.app.ticker.lastTime !== lastSeen) {
        lastSeen = this.app.ticker.lastTime;
        stalledSince = now;
        return;
      }
      if (now - stalledSince > 1500) {
        stalledSince = now;
        this.fit();
        this.app.ticker.stop();
        this.app.ticker.start();
      }
    }, 500);
    document.addEventListener("visibilitychange", this.refit);
    window.addEventListener("resize", this.refit);
  }

  private stopWatchdog(): void {
    if (this.watchdog !== null) window.clearInterval(this.watchdog);
    this.watchdog = null;
    document.removeEventListener("visibilitychange", this.refit);
    window.removeEventListener("resize", this.refit);
  }

  private readonly refit = (): void => {
    if (document.visibilityState === "visible") this.fit();
  };

  private fit(): void {
    const { clientWidth: w, clientHeight: h } = this.el;
    const fitted = fitScale(w, h, WORLD.w, WORLD.h);
    if (!fitted) return; // minimized / hidden: keep the last good size
    this.app.renderer.resize(w, h);
    this.base = fitted;
    this.camTarget = this.cameraFor(this.focused);
    if (this.focused === null) this.cam = { ...this.base };
    // A resize clears the canvas. Draw now, inside the ResizeObserver callback
    // (before the browser paints), or the page shows one blank frame.
    this.stepCamera(0);
    try {
      this.app.render();
    } catch {
      /* the guarded frame loop reports render errors; the next tick retries */
    }
  }

  private cameraFor(id: InteractId | null): { scale: number; x: number; y: number } {
    const rect = id ? focusRect(id) : null;
    if (!rect) return { ...this.base };
    const { clientWidth: w, clientHeight: h } = this.el;
    const [x0, y0, x1, y1] = rect;
    const viewH = h * (1 - PANEL_SHARE); // frame the focus above the bottom panel
    const scale = Math.min(this.base.scale * MAX_ZOOM, (w * 0.9) / (x1 - x0), (viewH * 0.9) / (y1 - y0));
    let x = w / 2 - ((x0 + x1) / 2) * scale;
    let y = viewH / 2 - ((y0 + y1) / 2) * scale;
    // keep the art filling the view where it can
    if (WORLD.w * scale > w) x = Math.min(0, Math.max(w - WORLD.w * scale, x));
    if (WORLD.h * scale > h) y = Math.min(0, Math.max(h - WORLD.h * scale, y));
    return { scale, x, y };
  }

  private stepCamera(deltaMs: number): void {
    const k = 1 - Math.exp(-deltaMs / 140);
    this.cam.scale += (this.camTarget.scale - this.cam.scale) * k;
    this.cam.x += (this.camTarget.x - this.cam.x) * k;
    this.cam.y += (this.camTarget.y - this.cam.y) * k;
    this.world.scale.set(this.cam.scale);
    this.world.position.set(this.cam.x, this.cam.y);
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
    this.world.addChild(new Sprite(backdrop), this.ambient.back, this.clickRing, this.hover);

    for (const agentId of AGENT_ORDER) this.buildSign(agentId);

    this.actors.sortableChildren = true;
    this.mainAgent = this.person(people.main_agent, MAIN_AGENT_POS);
    this.reviewer = this.person(people.reviewer, REVIEWER_POS);
    for (const agentId of AGENT_ORDER) {
      this.vendors[agentId] = this.person(people[VENDOR_SPRITE[agentId]], STALLS[agentId].home);
    }
    this.player = this.person(people.player, PLAYER_START);
    this.world.addChild(this.ambient.front, this.actors);

    const bubbles = new Container();
    for (const agentId of AGENT_ORDER) {
      this.vendorBubbles[agentId] = new Bubble(13);
      bubbles.addChild(this.vendorBubbles[agentId]);
    }
    bubbles.addChild(this.mainBubble, this.reviewBubble);

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
    this.world.addChild(bubbles, hud, this.banner, this.spent, panel, this.finalBg, this.finalText, this.fx, this.hoverLabel);

    this.world.eventMode = "static";
    this.world.hitArea = new Rectangle(0, 0, WORLD.w, WORLD.h);
    this.world.on("pointertap", (e: FederatedPointerEvent) => this.click(this.world.toLocal(e.global)));
    this.world.on("pointermove", (e: FederatedPointerEvent) => (this.pendingHover = this.world.toLocal(e.global)));
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
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
    const thing = hitTest(p, this.vendorPositions());
    const dest = standable(thing ? thing.approach : p);
    // The panel opens right away; the player still walks over. (Waiting for
    // the walk took seconds from across the pier, with no sign anything happened.)
    this.walkTo(dest);
    if (thing) this.onInteract(thing.id);
    if (!thing) {
      sfx.click();
      this.onGround();
    }
    this.clickRing.position.set(dest.x, dest.y);
    this.clickAge = 0;
  }

  /** Where each vendor is standing right now (they walk to the boat and the pier). */
  private vendorPositions(): Partial<Record<AgentId, Point>> {
    return Object.fromEntries(AGENT_ORDER.map((id) => [id, { x: this.vendors[id].x, y: this.vendors[id].y }]));
  }

  private setHover(p: Point): void {
    // Vendors move, so their box is rebuilt on every call (and the outline follows them).
    const thing = inPanel(p) ? "tasks" : hitTest(p, this.vendorPositions());
    const id = (t: typeof thing) => (t === null ? null : t === "tasks" ? "tasks" : t.id);
    // Same person, same spot: nothing to redraw. (A vendor's box is a new
    // object each call, so compare who it is and where, not the object.)
    if (id(thing) === id(this.hovered) && (thing === null || thing === "tasks" || this.hovered === null || this.hovered === "tasks" || thing.hit.join() === this.hovered.hit.join())) return;
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
    this.stepCamera(ticker.deltaMS);
    if (this.pendingHover) {
      this.setHover(this.pendingHover);
      this.pendingHover = null;
    }
    this.ambient.update(ticker);
    this.stepPlayer(ticker.deltaMS);
    // the main agent rides the boat's gentle bob
    this.mainAgent.y = MAIN_AGENT_POS.y + Math.sin(this.clock / 900) * 1.5;
    // bubbles follow their speakers; people overlap by depth
    for (const agentId of AGENT_ORDER) {
      const v = this.vendors[agentId];
      this.vendorBubbles[agentId].position.set(v.x, v.y - HEAD);
    }
    this.mainBubble.position.set(this.mainAgent.x, this.mainAgent.y - HEAD);
    this.reviewBubble.position.set(this.reviewer.x, this.reviewer.y - HEAD - 2);
    for (const child of this.actors.children) child.zIndex = child.y;
    if (this.clickAge < 450) {
      this.clickAge += ticker.deltaMS;
      const p = Math.min(1, this.clickAge / 450);
      this.clickRing.clear().ellipse(0, 0, 10 + 12 * p, 4 + 5 * p).stroke({ width: 2, color: PALETTE.paper, alpha: 1 - p });
    }
  };

  /** Keyboard walking: a key press cancels a click-walk; walls are slid along, not walked through. */
  private stepWithKeys(deltaMs: number): void {
    const player = this.player;
    const before = { x: player.x, y: player.y };
    this.walk = [];
    this.onArrive = null;
    let dx = (this.keys.has("right") ? 1 : 0) - (this.keys.has("left") ? 1 : 0);
    let dy = (this.keys.has("down") ? 1 : 0) - (this.keys.has("up") ? 1 : 0);
    if (!dx && !dy) return;
    const len = Math.hypot(dx, dy);
    const step = (PLAYER_SPEED * deltaMs) / 1000;
    dx = (dx / len) * step;
    dy = (dy / len) * step;
    if (walkable({ x: player.x + dx, y: player.y + dy })) player.position.set(player.x + dx, player.y + dy);
    else if (dx && walkable({ x: player.x + dx, y: player.y })) player.x += dx;
    else if (dy && walkable({ x: player.x, y: player.y + dy })) player.y += dy;
    if (player.x !== before.x || player.y !== before.y) {
      this.stepMs += deltaMs;
      if (this.stepMs >= 260) {
        this.stepMs = 0;
        sfx.step();
      }
    }
    if (dx) player.scale.x = (dx > 0 ? -1 : 1) * PEOPLE_SCALE;
    player.rotation = Math.sin(this.clock / 85) * 0.07;
  }

  private stepPlayer(deltaMs: number): void {
    const player = this.player;
    if (this.keys.size > 0) {
      this.stepWithKeys(deltaMs);
      return;
    }
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
    this.stepMs += deltaMs;
    if (this.stepMs >= 260) {
      this.stepMs = 0;
      sfx.step();
    }
    if (Math.abs(dx) > 0.5) player.scale.x = (dx > 0 ? -1 : 1) * PEOPLE_SCALE;
    player.rotation = Math.sin(this.clock / 85) * 0.07;
  }

  // ------------------------------------------------------------ state -> picture
  /** The winner's WON! / WORKING / DONE follow the animation; bidding bubbles follow the state. */
  private shownBubble(agentId: AgentId, fromState: StallModel["bubble"]): StallModel["bubble"] {
    if (!this.stageOf || !fromState || !WINNER_TONES.has(fromState.tone)) return fromState;
    const stage = this.stageOf(agentId);
    return stage === "none" ? null : STAGE_BUBBLE[stage];
  }

  private apply(model: SceneModel): void {
    this.banner.text = model.banner.length > 90 ? `${model.banner.slice(0, 87)}...` : model.banner;
    this.spent.text = model.spent;

    for (const agentId of AGENT_ORDER) {
      const stall = model.stalls.find((s) => s.agentId === agentId) ?? null;
      this.winnerFlags[agentId].visible = stall?.winner ?? false;
      const bubble = this.shownBubble(agentId, stall?.bubble ?? null);
      this.vendorBubbles[agentId].set(
        bubble?.text ?? null,
        bubble ? BUBBLE_TEXT[bubble.tone] : PALETTE.ink,
        bubble?.tone === "won" ? "#fff1c1" : PALETTE.paper,
      );
    }

    this.mainBubble.set(model.mainAgent);

    // The reviewer only reacts once the work has actually been handed over.
    if (this.handOverPending?.()) this.reviewBubble.set(null);
    else if (model.reviewing) this.reviewBubble.set("...", PALETTE.muted);
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
