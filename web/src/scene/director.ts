// Moves people in response to events, on top of the state-driven scene:
//   task posted -> every vendor walks out to the boat to hear it and bid
//   won         -> at the boat the Captain tosses the winner the task scroll; it
//                  carries it back and puts it on its counter, the rest go home
//   working     -> once it's home, the winner acts out the work
//   done        -> it picks the scroll up, walks it to the reviewer and hands it over
//   graded      -> the grade pops up after the hand-over, and the winner walks home
// Each vendor plays its steps in order (a script), so a fast event never
// teleports a scroll: nothing is picked up or dropped off before the vendor
// gets there. Skipping all of it never changes what MarketScene.render(state) shows.
import { Container, Graphics, type Sprite, type Text, type Ticker } from "pixi.js";

import { sfx } from "../audio/sfx";
import type { AbyssEvent, AgentId, TaskType } from "../contract";
import { AGENT_ORDER, verdict } from "./model";
import { PALETTE, SPENT_POS, text, type MarketScene, type VendorStage } from "./Scene";
import { MAIN_AGENT_POS, REVIEWER_POS, REVIEW_SPOT, STALLS, WORLD, route, type Point } from "./world";
import { isStopNote } from "../state/reducer";

const MAX_ACTIVE = 60;    // backlog guard: beyond this, finish every effect instantly
const WALK_SPEED = 330;   // world px per second at speed 1
const MAX_BEHIND_SECONDS = 7; // a vendor this far behind the market skips ahead
const TOSS_MS = 450;      // the scroll's flight between hands

/** One thing a vendor does: walk somewhere, do something, or pause. */
type Step = { walk: Point; path?: Point[] } | { act: () => void } | { wait: number };

/** Where the task scroll is: nowhere, in a vendor's hand, or on its counter. */
type Holding = "none" | "hand" | "counter";

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
  /** Each vendor's steps still to play, in order. */
  private readonly scripts = {} as Record<AgentId, Step[]>;
  /** The task scroll each vendor carries between the boat, its stall and the reviewer. */
  readonly carrying = {} as Record<AgentId, Graphics>;
  private readonly holding = {} as Record<AgentId, Holding>;
  /** What each vendor is visibly doing with a task it won; the scene's bubbles follow this. */
  private readonly stage = {} as Record<AgentId, VendorStage>;
  /** Finished work still on its way to the reviewer (the reviewer waits for it). */
  private handOvers = 0;
  /** What each task is, so a vendor's work animation matches its task type. */
  private readonly taskTypes = new Map<string, TaskType>();
  /** Vendors currently working, and on what kind of task. */
  private readonly working = new Map<AgentId, TaskType>();
  private clock = 0;
  /** True while a vendor skips ahead: its steps happen at once, so they stay silent. */
  private settling = false;

  constructor(
    private readonly scene: MarketScene,
    private readonly speed = 1,
  ) {
    for (const agentId of AGENT_ORDER) {
      this.scripts[agentId] = [];
      this.holding[agentId] = "none";
      this.stage[agentId] = "none";
      const scroll = makeScroll();
      scroll.visible = false;
      this.carrying[agentId] = scroll;
      scene.fx.addChild(scroll);
    }
    scene.stageOf = (agentId) => this.stage[agentId];
    scene.handOverPending = () => this.handOvers > 0;
    scene.app.ticker.add(this.tick);
  }

  destroy(): void {
    this.scene.app.ticker.remove(this.tick);
    this.scene.stageOf = null;
    this.scene.handOverPending = null;
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
        for (const agentId of AGENT_ORDER) this.plan(agentId, { walk: STALLS[agentId].gather });
        break;
      case "bid":
        if (ev.data.ok) {
          const v = this.scene.vendors[ev.data.agent_id];
          if (fx) this.burst(v.x, v.y - 60, PALETTE.paper, 22);
        }
        break;
      case "won": {
        const winner = ev.data.agent_id;
        this.plan(
          winner,
          // Already queued: the walk out to the boat. The Captain tosses the scroll once it's there.
          { act: () => this.toss(this.captainHand(), () => this.handOf(winner)) },
          { wait: TOSS_MS },
          {
            act: () => {
              this.hold(winner, "hand");
              this.setStage(winner, "won");
              if (!fx) return; // catching up: no fanfare
              this.sound(() => sfx.won()); // as the scroll lands in the winner's hand, not when the event arrives
              const v = this.scene.vendors[winner];
              this.burst(v.x, v.y - 40, PALETTE.gold, 40);
              this.floatText("GOT IT!", PALETTE.gold, v.x, v.y - 90, 1200, 18);
            },
          },
          { walk: STALLS[winner].home },
          { act: () => this.hold(winner, "counter") },
        );
        for (const agentId of AGENT_ORDER) if (agentId !== winner) this.plan(agentId, { walk: STALLS[agentId].home });
        break;
      }
      case "working": {
        const { agent_id: agentId, task_id: taskId } = ev.data;
        // starts once the vendor is back at its stall with the scroll on the counter
        this.plan(agentId, {
          act: () => {
            const type = this.taskTypes.get(taskId);
            if (type) this.working.set(agentId, type);
            this.setStage(agentId, "working");
            if (fx) this.sound(() => sfx.working());
          },
        });
        break;
      }
      case "done": {
        const agentId = ev.data.agent_id;
        const cost = Math.round(ev.data.usage.cost_usd * 1000);
        const coins = Math.max(1, Math.min(14, cost));
        this.handOvers += 1;
        this.scene.refreshBubbles();
        this.plan(
          agentId,
          {
            act: () => {
              this.stopWork(agentId);
              this.hold(agentId, "hand");
              this.setStage(agentId, "done");
              if (!fx) return;
              this.sound(() => sfx.done(cost));
              const home = STALLS[agentId].home;
              for (let i = 0; i < coins; i += 1) this.coin(home.x, home.y - 40, i * 70);
            },
          },
          { walk: REVIEW_SPOT },
          { act: () => { this.hold(agentId, "none"); this.toss(this.handOf(agentId), () => this.reviewerHand()); } },
          { wait: TOSS_MS },
          { act: () => this.handedOver() },
        );
        break;
      }
      case "graded": {
        const agentId = ev.data.agent_id;
        const promised = ev.data.promised_quality;
        const graded = verdict(ev.data.grade, promised);
        const tone = PALETTE[graded];
        const grade = `${ev.data.grade}/10`;
        // the grade shows once the work is in the reviewer's hands
        this.plan(
          agentId,
          {
            act: () => {
              this.setStage(agentId, "none");
              if (!fx) return;
              this.floatText(grade, tone, REVIEWER_POS.x, REVIEWER_POS.y - 100, 1500, 26);
              this.sound(() => sfx.graded(graded));
            },
          },
          { walk: STALLS[agentId].home },
        );
        break;
      }
      case "rep_update": {
        const delta = ev.data.new - ev.data.old;
        if (!fx || Math.abs(delta) < 0.0005) break;
        const sign = STALLS[ev.data.agent_id].sign;
        const label = `${delta > 0 ? "+" : ""}${delta.toFixed(3)} ${ev.data.task_type.toUpperCase()}`;
        // right after the grade it comes from (which waits for the hand-over), before the walk home
        const show: Step = { act: () => this.floatText(label, delta > 0 ? PALETTE.good : PALETTE.bad, sign.x, sign.y - 36, 1700, 14) };
        const script = this.scripts[ev.data.agent_id];
        const last = script[script.length - 1];
        if (last && "walk" in last && !last.path) script.splice(script.length - 1, 0, show);
        else this.plan(ev.data.agent_id, show);
        break;
      }
      case "error":
        if (ev.job_id === null && !ev.data.fatal) break; // one connection's refusal, not the market's
        if (ev.data.task_id) {
          for (const agentId of AGENT_ORDER) {
            this.plan(agentId, { act: () => { this.hold(agentId, "none"); this.stopWork(agentId); this.setStage(agentId, "none"); } });
          }
        }
        if (ev.data.fatal) this.sendEveryoneHome();
        break;
      case "steered":
        if (ev.job_id && ev.data.target === "job" && isStopNote(ev.data.note)) this.stopped.add(ev.job_id);
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

  // ---------------------------------------------------------------- scripts
  /** Queue steps for a vendor; one that has fallen far behind the market skips ahead first. */
  private plan(agentId: AgentId, ...steps: Step[]): void {
    const script = this.scripts[agentId];
    if (this.secondsBehind(agentId) > MAX_BEHIND_SECONDS) this.settle(agentId);
    for (const step of steps) {
      const last = script[script.length - 1];
      // A walk that hasn't started yet and is followed straight by another is
      // pointless (home, then right back out to the boat): go to the new place.
      if ("walk" in step && last && "walk" in last && !last.path) script[script.length - 1] = step;
      else script.push(step);
    }
  }

  /** Roughly how long this vendor's queued walks and pauses will take. */
  private secondsBehind(agentId: AgentId): number {
    const v = this.scene.vendors[agentId];
    let at: Point = { x: v.x, y: v.y };
    let ms = 0;
    for (const s of this.scripts[agentId]) {
      if ("walk" in s) {
        ms += (Math.hypot(s.walk.x - at.x, s.walk.y - at.y) / WALK_SPEED) * 1000;
        at = s.walk;
      } else if ("wait" in s) ms += s.wait;
    }
    return ms / 1000 / this.speed;
  }

  /** Play every queued step instantly: effects happen, the vendor lands where it was going. */
  private settle(agentId: AgentId): void {
    const v = this.scene.vendors[agentId];
    this.settling = true;
    try {
      for (const s of this.scripts[agentId].splice(0)) {
        if ("act" in s) s.act();
        else if ("walk" in s) v.position.set(s.walk.x, s.walk.y);
      }
    } finally {
      this.settling = false;
    }
    resetPose(v);
  }

  /** A sound that belongs to this moment of the animation. */
  private sound(play: () => void): void {
    if (!this.settling) play();
  }

  private sendEveryoneHome(): void {
    for (const agentId of AGENT_ORDER) {
      this.plan(agentId, { act: () => { this.stopWork(agentId); this.hold(agentId, "none"); this.setStage(agentId, "none"); } }, { walk: STALLS[agentId].home });
    }
  }

  /** Run the head of a vendor's script for this frame. */
  private play(agentId: AgentId, deltaMs: number): void {
    const script = this.scripts[agentId];
    const sprite = this.scene.vendors[agentId];
    // instant steps run back to back in the same frame
    while (script[0] && "act" in script[0]) (script.shift() as { act: () => void }).act();
    const s = script[0];
    if (!s) {
      sprite.rotation = 0;
      return;
    }
    if ("wait" in s) {
      s.wait -= deltaMs * this.speed;
      if (s.wait <= 0) script.shift();
      return;
    }
    s.path ??= route({ x: sprite.x, y: sprite.y }, s.walk);
    if (this.step(sprite, s.path, deltaMs)) script.shift();
  }

  /** Walk along a path; true once the last point is reached. */
  private step(sprite: Sprite, path: Point[], deltaMs: number): boolean {
    let budget = (WALK_SPEED * this.speed * deltaMs) / 1000;
    while (path.length > 0) {
      const target = path[0];
      const dx = target.x - sprite.x;
      const dy = target.y - sprite.y;
      const dist = Math.hypot(dx, dy);
      if (Math.abs(dx) > 0.5) sprite.scale.x = Math.abs(sprite.scale.x) * (dx > 0 ? 1 : -1);
      if (dist > budget) {
        sprite.x += (dx / dist) * budget;
        sprite.y += (dy / dist) * budget;
        sprite.rotation = Math.sin(this.clock / 85) * 0.07;
        return false;
      }
      sprite.position.set(target.x, target.y);
      budget -= dist;
      path.shift();
    }
    sprite.rotation = 0;
    return true;
  }

  private setStage(agentId: AgentId, stage: VendorStage): void {
    this.stage[agentId] = stage;
    this.scene.refreshBubbles();
  }

  private handedOver(): void {
    this.handOvers = Math.max(0, this.handOvers - 1);
    this.scene.refreshBubbles();
  }

  private stopWork(agentId: AgentId): void {
    this.working.delete(agentId);
    resetPose(this.scene.vendors[agentId]);
  }

  // ---------------------------------------------------------------- the scroll
  private hold(agentId: AgentId, where: Holding): void {
    this.holding[agentId] = where;
    this.carrying[agentId].visible = where !== "none";
  }

  /** In front of the vendor, on the side it faces, at hand height. */
  private handOf(agentId: AgentId): Point {
    const v = this.scene.vendors[agentId];
    const facing = Math.sign(v.scale.x) || 1;
    return { x: v.x + 16 * facing, y: v.y - 40 };
  }

  private captainHand(): Point {
    return { x: this.scene.mainAgent.x + 14, y: this.scene.mainAgent.y - 48 };
  }

  private reviewerHand(): Point {
    return { x: this.scene.reviewer.x + 14, y: this.scene.reviewer.y - 44 };
  }

  /** A scroll flies in an arc from one hand to another (the target may be moving). */
  private toss(from: Point, to: () => Point): void {
    const flying = makeScroll();
    this.add(flying, TOSS_MS, (p) => {
      const end = to();
      flying.x = from.x + (end.x - from.x) * p;
      flying.y = from.y + (end.y - from.y) * p - 46 * Math.sin(Math.PI * p);
      flying.rotation = Math.PI * 2 * p * (end.x >= from.x ? 1 : -1);
    });
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
      this.play(agentId, ticker.deltaMS);
      const scroll = this.carrying[agentId];
      const where = this.holding[agentId];
      if (where === "hand") {
        const hand = this.handOf(agentId);
        const walking = this.scripts[agentId][0] !== undefined && "walk" in this.scripts[agentId][0];
        scroll.position.set(hand.x, hand.y + (walking ? Math.sin(this.clock / 85) * 1.5 : 0));
        scroll.rotation = 0;
      } else if (where === "counter") {
        const home = STALLS[agentId].home;
        scroll.position.set(home.x + 34, home.y - 50);
        scroll.rotation = -0.2;
      }
    }
    for (const [agentId, type] of this.working) {
      // at the stall the vendor's own body shows the kind of work (walking has its waddle)
      if (this.scripts[agentId].length === 0) workPose(this.scene.vendors[agentId], type, this.clock);
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

/** The little task scroll: cream paper with wooden rollers. */
function makeScroll(): Graphics {
  return new Graphics().roundRect(-8, -5, 16, 10, 2).fill(PALETTE.cream)
    .rect(-8, -5, 3, 10).fill("#b07a45").rect(5, -5, 3, 10).fill("#b07a45");
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
