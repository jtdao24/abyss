// Event-driven motion on top of the state-driven scene: a courier carries each
// task crate hub → winning stall → Task Delivery, plus pops, coins and floating
// numbers. Skipping all of it never changes what MarketScene.render(state) shows.
import { Container, Graphics, type Text, type Ticker } from "pixi.js";

import type { AbyssEvent } from "../contract";
import {
  COURIER_HOME,
  DELIVERY_SPOT,
  HUB_SPOT,
  OFFICER,
  PALETTE,
  SPENT_POS,
  STALLS,
  WORLD,
  text,
  type MarketScene,
} from "./Scene";

const MAX_ACTIVE = 60; // backlog guard: beyond this, finish every effect instantly
const COURIER_SPEED = 520; // world px per second at speed 1

interface Tween {
  elapsed: number;
  duration: number;
  node: Container;
  update(progress: number): void;
}

type Point = { x: number; y: number };

const ease = (p: number) => 1 - (1 - p) * (1 - p);

export class Director {
  private readonly tweens: Tween[] = [];
  private readonly route: Point[] = [];
  private walkClock = 0;

  constructor(
    private readonly scene: MarketScene,
    private readonly speed = 1,
  ) {
    scene.app.ticker.add(this.tick);
  }

  destroy(): void {
    this.scene.app.ticker.remove(this.tick);
    this.finishAll();
  }

  onEvent(ev: AbyssEvent): void {
    switch (ev.type) {
      case "job_split":
        this.floatText("NEW JOB!", PALETTE.gold, HUB_SPOT.x, 400, 1100, 44);
        break;
      case "task_posted":
        this.floatText(`TASK ${ev.data.index + 1}/${ev.data.total}`, PALETTE.paper, HUB_SPOT.x, 640, 1000, 32);
        this.walk([HUB_SPOT]);
        break;
      case "bid":
        if (ev.data.ok) this.burst(STALLS[ev.data.agent_id].front.x, STALLS[ev.data.agent_id].front.y, PALETTE.paper, 70);
        break;
      case "won": {
        const stall = STALLS[ev.data.agent_id];
        this.burst(stall.front.x, 900, PALETTE.gold, 150);
        this.floatText("SOLD!", PALETTE.gold, stall.front.x, 860, 1300, 56);
        this.walk([HUB_SPOT, { x: stall.front.x, y: stall.front.y + 70 }]);
        break;
      }
      case "done": {
        const stall = STALLS[ev.data.agent_id];
        const coins = Math.max(1, Math.min(20, Math.round(ev.data.usage.cost_usd * 1000)));
        for (let i = 0; i < coins; i += 1) this.coin(stall.front.x, 900, i * 70);
        this.walk([{ x: stall.front.x, y: stall.front.y + 70 }, DELIVERY_SPOT]);
        break;
      }
      case "graded": {
        const promised = ev.data.promised_quality;
        const tone = promised === null || ev.data.grade >= promised ? PALETTE.good
          : ev.data.grade < promised - 1 ? PALETTE.bad : PALETTE.ok;
        this.floatText(`${ev.data.grade}/10`, tone, OFFICER.x, 960, 1500, 60);
        this.walk([COURIER_HOME]);
        break;
      }
      case "rep_update": {
        const delta = ev.data.new - ev.data.old;
        if (Math.abs(delta) < 0.0005) break;
        const [x0, , x1] = STALLS[ev.data.agent_id].label;
        const label = `${delta > 0 ? "+" : ""}${delta.toFixed(3)} ${ev.data.task_type.toUpperCase()}`;
        this.floatText(label, delta > 0 ? PALETTE.good : PALETTE.bad, (x0 + x1) / 2, 900, 1600, 30);
        break;
      }
      case "final":
        this.floatText(ev.data.status === "ok" ? "JOB DONE!" : `JOB ${ev.data.status.toUpperCase()}`,
          PALETTE.gold, WORLD.w / 2, WORLD.h / 2 - 120, 2200, 96);
        this.walk([COURIER_HOME]);
        break;
      case "error":
        if (ev.data.fatal) this.walk([COURIER_HOME]);
        break;
      default:
        break;
    }
  }

  // ---------------------------------------------------------------- courier
  private walk(points: Point[]): void {
    this.route.push(...points);
    // Far behind (fast replay or a burst of events): skip to the latest stop.
    if (this.route.length > 6) {
      const last = this.route[this.route.length - 1];
      this.route.length = 0;
      this.scene.courier.position.set(last.x, last.y);
    }
  }

  private stepCourier(deltaMs: number): void {
    const courier = this.scene.courier;
    const target = this.route[0];
    if (!target) {
      courier.rotation = 0;
      return;
    }
    const dx = target.x - courier.x;
    const dy = target.y - courier.y;
    const dist = Math.hypot(dx, dy);
    const step = (COURIER_SPEED * this.speed * deltaMs) / 1000;
    if (dist <= step) {
      courier.position.set(target.x, target.y);
      this.route.shift();
      return;
    }
    courier.x += (dx / dist) * step;
    courier.y += (dy / dist) * step;
    // The sprite faces left; mirror it when walking right. Waddle while moving.
    courier.scale.x = dx > 0 ? -1 : 1;
    this.walkClock += deltaMs;
    courier.rotation = Math.sin(this.walkClock / 90) * 0.06;
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
    t.style.stroke = { color: PALETTE.ink, width: Math.max(4, size / 7) };
    t.position.set(x, y);
    this.add(t, ms, (p) => {
      t.y = y - 50 * ease(p);
      t.alpha = p < 0.7 ? 1 : 1 - (p - 0.7) / 0.3;
    });
  }

  private burst(x: number, y: number, color: string, radius: number): void {
    for (let i = 0; i < 10; i += 1) {
      const angle = (Math.PI * 2 * i) / 10;
      const spark = new Graphics().rect(-5, -5, 10, 10).fill(color);
      this.add(spark, 650, (p) => {
        spark.x = x + Math.cos(angle) * radius * ease(p);
        spark.y = y + Math.sin(angle) * radius * 0.6 * ease(p);
        spark.alpha = 1 - p;
      });
    }
  }

  private coin(x: number, y: number, delayMs: number): void {
    const coin = new Graphics().circle(0, 0, 12).fill(PALETTE.ink).circle(0, 0, 9).fill(PALETTE.gold);
    const to = { x: SPENT_POS.x - 120, y: SPENT_POS.y };
    this.add(coin, 900, (p) => {
      coin.x = x + (to.x - x) * p;
      coin.y = y + (to.y - y) * p - 200 * Math.sin(Math.PI * p);
    }, delayMs);
  }

  // ---------------------------------------------------------------- loop
  private finishAll(): void {
    for (const tween of this.tweens.splice(0)) tween.node.destroy();
  }

  private readonly tick = (ticker: Ticker): void => {
    this.stepCourier(ticker.deltaMS);
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
