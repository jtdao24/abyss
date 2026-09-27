// Moves people in response to events, on top of the state-driven scene:
//   task posted -> every vendor walks out to the boat to hear it and bid
//   won         -> the winner carries the task back to its stall, the rest go home
//   done        -> the winner walks its work to the reviewer on the pier
//   graded      -> the winner walks home
// plus pops, coins and floating numbers. Skipping all of it never changes what
// MarketScene.render(state) shows.
import { Container, Graphics, type Sprite, type Text, type Ticker } from "pixi.js";

import type { AbyssEvent, AgentId, TaskType } from "../contract";
import { AGENT_ORDER } from "./model";
import { PALETTE, SPENT_POS, text, type MarketScene } from "./Scene";
import { MAIN_AGENT_POS, REVIEWER_POS, REVIEW_SPOT, STALLS, WORLD, route, type Point } from "./world";

const MAX_ACTIVE = 60;    // backlog guard: beyond this, finish every effect instantly
const WALK_SPEED = 330;   // world px per second at speed 1
const MAX_QUEUED = 8;     // a vendor further behind than this jumps to its last stop

interface Tween {
  elapsed: number;
  duration: number;
  node: Container;
  update(progress: number): void;
}

const ease = (p: number) => 1 - (1 - p) * (1 - p);

export class Director {
  private readonly tweens: Tween[] = [];
  /** Jobs the user stopped: their final says STOPPED, not PARTIAL. */
  private readonly stopped = new Set<string>();
  private readonly routes = {} as Record<AgentId, Point[]>;
  private readonly carrying = {} as Record<AgentId, Graphics>;
  /** What each task is, so a vendor's work animation matches its task type. */
  private readonly taskTypes = new Map<string, TaskType>();
  /** Vendors currently working, and on what kind of task. */
  private readonly working = new Map<AgentId, TaskType>();
  private clock = 0;

  constructor(
    private readonly scene: MarketScene,
    private readonly speed = 1,
  ) {
    for (const agentId of AGENT_ORDER) {
      this.routes[agentId] = [];
      // a little task scroll a vendor carries between the boat and its stall
      const scroll = new Graphics().roundRect(-8, -5, 16, 10, 2).fill(PALETTE.cream)
        .rect(-8, -5, 3, 10).fill("#b07a45").rect(5, -5, 3, 10).fill("#b07a45");
      scroll.visible = false;
      this.carrying[agentId] = scroll;
      scene.fx.addChild(scroll);
    }
    scene.app.ticker.add(this.tick);
  }

  destroy(): void {
    this.scene.app.ticker.remove(this.tick);
    this.finishAll();
    for (const agentId of AGENT_ORDER) this.stopWork(agentId);
  }

  /**
   * Play one event. `quiet` is for catching up (a tab that joins mid-job, or
   * after a reconnect): keep track of who is carrying and working, but skip
   * the one-off effects (bursts, coins, floating text) so a backlog doesn't
   * fire every fanfare at once.
   */
  onEvent(ev: AbyssEvent, quiet = false): void {
    const fx = !quiet;
    switch (ev.type) {
      case "job_split":
        if (fx) this.floatText("NEW JOB!", PALETTE.gold, MAIN_AGENT_POS.x, MAIN_AGENT_POS.y - 90, 1300, 20);
        break;
      case "task_posted":
        this.taskTypes.set(ev.data.task_id, ev.data.type);
        for (const agentId of AGENT_ORDER) this.walk(agentId, STALLS[agentId].gather);
        break;
      case "bid":
        if (ev.data.ok) {
          const v = this.scene.vendors[ev.data.agent_id];
          if (fx) this.burst(v.x, v.y - 60, PALETTE.paper, 22);
        }
        break;
      case "won": {
        const v = this.scene.vendors[ev.data.agent_id];
        if (fx) this.burst(v.x, v.y - 40, PALETTE.gold, 40);
        if (fx) this.floatText("GOT IT!", PALETTE.gold, v.x, v.y - 90, 1200, 18);
        this.carrying[ev.data.agent_id].visible = true;
        for (const agentId of AGENT_ORDER) this.walk(agentId, STALLS[agentId].home);
        break;
      }
      case "working": {
        const type = this.taskTypes.get(ev.data.task_id);
        if (type) this.working.set(ev.data.agent_id, type);
        break;
      }
      case "done": {
        const agentId = ev.data.agent_id;
        this.stopWork(agentId);
        this.carrying[agentId].visible = true;
        const coins = Math.max(1, Math.min(14, Math.round(ev.data.usage.cost_usd * 1000)));
        const home = STALLS[agentId].home;
        if (fx) for (let i = 0; i < coins; i += 1) this.coin(home.x, home.y - 40, i * 70);
        this.walk(agentId, REVIEW_SPOT);
        break;
      }
      case "graded": {
        const agentId = ev.data.agent_id;
        const promised = ev.data.promised_quality;
        const tone = promised === null || ev.data.grade >= promised ? PALETTE.good
          : ev.data.grade < promised - 1 ? PALETTE.bad : PALETTE.ok;
        if (fx) this.floatText(`${ev.data.grade}/10`, tone, REVIEWER_POS.x, REVIEWER_POS.y - 100, 1500, 26);
        this.carrying[agentId].visible = false;
        this.walk(agentId, STALLS[agentId].home);
        break;
      }
      case "rep_update": {
        const delta = ev.data.new - ev.data.old;
        if (Math.abs(delta) < 0.0005) break;
        const sign = STALLS[ev.data.agent_id].sign;
        const label = `${delta > 0 ? "+" : ""}${delta.toFixed(3)} ${ev.data.task_type.toUpperCase()}`;
        if (fx) this.floatText(label, delta > 0 ? PALETTE.good : PALETTE.bad, sign.x, sign.y - 36, 1700, 14);
        break;
      }
      case "error":
        if (ev.data.task_id) {
          for (const agentId of AGENT_ORDER) {
            this.carrying[agentId].visible = false;
            this.stopWork(agentId);
          }
        }
        if (ev.data.fatal) this.sendEveryoneHome();
        break;
      case "steered":
        if (ev.job_id && ev.data.note.startsWith("Stop:")) this.stopped.add(ev.job_id);
        break;
      case "final":
        if (fx) this.floatText(
          ev.job_id && this.stopped.has(ev.job_id) ? "JOB STOPPED" : ev.data.status === "ok" ? "JOB DONE!" : `JOB ${ev.data.status.toUpperCase()}`,
          PALETTE.gold, WORLD.w / 2, WORLD.h / 2, 2200, 48);
        this.sendEveryoneHome();
        break;
      default:
        break;
    }
  }

  // ---------------------------------------------------------------- walking
  private walk(agentId: AgentId, to: Point): void {
    const queue = this.routes[agentId];
    const from = queue[queue.length - 1] ?? { x: this.scene.vendors[agentId].x, y: this.scene.vendors[agentId].y };
    queue.push(...route(from, to));
    if (queue.length > MAX_QUEUED) {
      const last = queue[queue.length - 1];
      queue.length = 0;
      this.scene.vendors[agentId].position.set(last.x, last.y);
    }
  }

  private stopWork(agentId: AgentId): void {
    this.working.delete(agentId);
    resetPose(this.scene.vendors[agentId]);
  }

  private sendEveryoneHome(): void {
    for (const agentId of AGENT_ORDER) {
      this.stopWork(agentId);
      this.carrying[agentId].visible = false;
      this.walk(agentId, STALLS[agentId].home);
    }
  }

  private step(sprite: Sprite, queue: Point[], deltaMs: number): void {
    const target = queue[0];
    if (!target) {
      sprite.rotation = 0;
      return;
    }
    const dx = target.x - sprite.x;
    const dy = target.y - sprite.y;
    const dist = Math.hypot(dx, dy);
    const step = (WALK_SPEED * this.speed * deltaMs) / 1000;
    if (dist <= step) {
      sprite.position.set(target.x, target.y);
      queue.shift();
      return;
    }
    sprite.x += (dx / dist) * step;
    sprite.y += (dy / dist) * step;
    if (Math.abs(dx) > 0.5) sprite.scale.x = Math.abs(sprite.scale.x) * (dx > 0 ? 1 : -1);
    sprite.rotation = Math.sin(this.clock / 85) * 0.07;
  }

  // ---------------------------------------------------------------- effects
  private add(node: Container, durationMs: number, update: (p: number) => void, delayMs = 0): void {
    const tween: Tween = { elapsed: -delayMs / this.speed, duration: durationMs / this.speed, node, update };
    node.visible = delayMs <= 0;
    this.scene.fx.addChild(node);
    this.tweens.push(tween);
    if (this.tweens.length > MAX_ACTIVE) this.finishAll();
  }

  private floatText(value: string, fill: string, x: number, y: number, ms: number, size: number): void {
    const t: Text = text(value, size, fill);
    t.style.stroke = { color: PALETTE.ink, width: Math.max(3, size / 6) };
    t.position.set(x, y);
    this.add(t, ms, (p) => {
      t.y = y - 24 * ease(p);
      t.alpha = p < 0.7 ? 1 : 1 - (p - 0.7) / 0.3;
    });
  }

  private burst(x: number, y: number, color: string, radius: number): void {
    for (let i = 0; i < 8; i += 1) {
      const angle = (Math.PI * 2 * i) / 8;
      const spark = new Graphics().rect(-2, -2, 4, 4).fill(color);
      this.add(spark, 600, (p) => {
        spark.x = x + Math.cos(angle) * radius * ease(p);
        spark.y = y + Math.sin(angle) * radius * 0.6 * ease(p);
        spark.alpha = 1 - p;
      });
    }
  }

  private coin(x: number, y: number, delayMs: number): void {
    const coin = new Graphics().circle(0, 0, 6).fill(PALETTE.ink).circle(0, 0, 4).fill(PALETTE.gold);
    const to = { x: SPENT_POS.x - 60, y: SPENT_POS.y };
    this.add(coin, 900, (p) => {
      coin.x = x + (to.x - x) * p;
      coin.y = y + (to.y - y) * p - 90 * Math.sin(Math.PI * p);
    }, delayMs);
  }

  // ---------------------------------------------------------------- loop
  private finishAll(): void {
    for (const tween of this.tweens.splice(0)) tween.node.destroy();
  }

  private readonly tick = (ticker: Ticker): void => {
    this.clock += ticker.deltaMS;
    for (const agentId of AGENT_ORDER) {
      const v = this.scene.vendors[agentId];
      this.step(v, this.routes[agentId], ticker.deltaMS);
      const scroll = this.carrying[agentId];
      if (scroll.visible) scroll.position.set(v.x + 20, v.y - 40);
    }
    for (const [agentId, type] of this.working) {
      // at the stall the vendor's own body shows the kind of work (walking has its waddle)
      if (this.routes[agentId].length === 0) workPose(this.scene.vendors[agentId], type, this.clock);
    }
    for (let i = this.tweens.length - 1; i >= 0; i -= 1) {
      const tween = this.tweens[i];
      tween.elapsed += ticker.deltaMS;
      if (tween.elapsed < 0) continue;
      tween.node.visible = true;
      const p = Math.min(1, tween.elapsed / tween.duration);
      tween.update(p);
      if (p >= 1) {
        tween.node.destroy();
        this.tweens.splice(i, 1);
      }
    }
  };
}

/** The vendor's body acts out the work: search, scribble or nod. */
function workPose(sprite: Sprite, type: TaskType, clock: number): void {
  const base = Math.abs(sprite.scale.x) || 1; // width is only ever flipped, never squashed
  resetPose(sprite);
  if (type === "research") {
    // look one way, then the other, leaning in, with a small hop on each turn
    const phase = Math.floor(clock / 1100) % 2 === 0 ? 1 : -1;
    const inTurn = (clock % 1100) / 1100;
    sprite.scale.x = base * phase;
    sprite.skew.x = 0.12 * phase;
    sprite.pivot.y = inTurn < 0.18 ? Math.sin((inTurn / 0.18) * Math.PI) * 9 : Math.sin(clock / 260) * 1.5;
  } else if (type === "writing") {
    // hunched over, scribbling fast
    sprite.skew.x = 0.07 * Math.sign(sprite.scale.x || 1);
    sprite.rotation = Math.sin(clock / 70) * 0.05;
    sprite.pivot.y = Math.abs(Math.sin(clock / 95)) * 4;
  } else {
    // steady nods while ticking things off, swaying a little between them
    const nod = Math.max(0, Math.sin(clock / 230));
    sprite.scale.y = base * (1 - 0.08 * nod);
    sprite.rotation = 0.06 * nod * Math.sign(sprite.scale.x || 1) + Math.sin(clock / 900) * 0.03;
  }
}

function resetPose(sprite: Sprite): void {
  const base = Math.abs(sprite.scale.x) || 1;
  sprite.scale.y = base;
  sprite.skew.set(0, 0);
  sprite.pivot.y = 0;
  sprite.rotation = 0;
}
