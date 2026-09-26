// Event-driven decoration on top of the state-driven scene. Every effect lives
// on scene.fx and removes itself; skipping all of them never changes what
// MarketScene.render(state) shows.
import { Container, Graphics, Text, type Ticker } from "pixi.js";

import type { AbyssEvent, AgentId } from "../contract";
import { COLORS } from "./sprites";
import { BOARD_POS, LIGHTHOUSE_X, STALL_X, TILL_POS, WIDTH, type MarketScene } from "./Scene";

const MAX_ACTIVE = 40; // backlog guard: beyond this, finish everything instantly
const SPARK_EVERY_MS = 220;

interface Tween {
  elapsed: number;
  duration: number;
  node: Container;
  update(progress: number): void;
}

const ease = (p: number) => 1 - (1 - p) * (1 - p);

function label(value: string, fill: string, size = 8): Text {
  const t = new Text({ text: value, style: { fontFamily: ["Silkscreen", "monospace"], fontSize: size, fill } });
  t.anchor.set(0.5);
  t.roundPixels = true;
  return t;
}

export class Director {
  private readonly tweens: Tween[] = [];
  private readonly working = new Set<AgentId>();
  private sparkClock = 0;

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
        this.working.clear();
        this.floatText("NEW JOB", COLORS.gold, BOARD_POS.x + 43, BOARD_POS.y - 4, 900, 12);
        break;
      case "task_posted":
        this.flyCard(ev.data.index);
        break;
      case "bid":
        if (ev.data.ok) this.burst(STALL_X[ev.data.agent_id], 32, COLORS.cream, 14);
        break;
      case "won":
        this.burst(STALL_X[ev.data.agent_id], 70, COLORS.gold, 22);
        this.floatText("SOLD!", COLORS.gold, STALL_X[ev.data.agent_id], 96, 1200, 12);
        break;
      case "working":
        this.working.add(ev.data.agent_id);
        break;
      case "done": {
        this.working.delete(ev.data.agent_id);
        const coins = Math.max(1, Math.min(20, Math.round(ev.data.usage.cost_usd * 1000)));
        for (let i = 0; i < coins; i += 1) this.coin(STALL_X[ev.data.agent_id], 130, i * 60);
        break;
      }
      case "graded": {
        const promised = ev.data.promised_quality;
        const tone =
          promised === null || ev.data.grade >= promised ? COLORS.good
            : ev.data.grade < promised - 1 ? COLORS.bad : COLORS.ok;
        this.beam(STALL_X[ev.data.agent_id]);
        this.floatText(`${ev.data.grade}/10`, tone, STALL_X[ev.data.agent_id], 95, 1500, 16);
        break;
      }
      case "rep_update": {
        const delta = ev.data.new - ev.data.old;
        if (Math.abs(delta) < 0.0005) break;
        const text = `${delta > 0 ? "+" : ""}${delta.toFixed(3)} ${ev.data.task_type.slice(0, 1).toUpperCase()}`;
        this.floatText(text, delta > 0 ? COLORS.good : COLORS.bad, STALL_X[ev.data.agent_id] + 3, 120, 1400);
        break;
      }
      case "final":
        this.working.clear();
        this.floatText(ev.data.status === "ok" ? "JOB DONE" : `JOB ${ev.data.status.toUpperCase()}`,
          COLORS.gold, WIDTH / 2, 110, 2000, 24);
        break;
      case "error":
        if (ev.data.fatal) this.working.clear();
        break;
      default:
        break;
    }
  }

  // ---------------------------------------------------------------- effects
  private add(node: Container, durationMs: number, update: (p: number) => void, delayMs = 0): void {
    const duration = durationMs / this.speed;
    const tween: Tween = { elapsed: -delayMs / this.speed, duration, node, update };
    node.visible = delayMs <= 0;
    this.scene.fx.addChild(node);
    this.tweens.push(tween);
    if (this.tweens.length > MAX_ACTIVE) this.finishAll();
  }

  private floatText(value: string, fill: string, x: number, y: number, ms: number, size = 8): void {
    const t = label(value, fill, size);
    t.position.set(x, y);
    this.add(t, ms, (p) => {
      t.y = Math.round(y - 14 * ease(p));
      t.alpha = p < 0.7 ? 1 : 1 - (p - 0.7) / 0.3;
    });
  }

  private flyCard(index: number): void {
    const card = new Graphics().rect(0, 0, 22, 14).fill(COLORS.cream).rect(2, 3, 14, 1).rect(2, 6, 18, 1)
      .rect(2, 9, 10, 1).fill(COLORS.dim);
    const from = { x: BOARD_POS.x + 43, y: BOARD_POS.y + 16 + index * 14 };
    const to = { x: STALL_X.sonnet - 11, y: 168 };
    this.add(card, 900, (p) => {
      const e = ease(p);
      card.x = Math.round(from.x + (to.x - from.x) * e);
      card.y = Math.round(from.y + (to.y - from.y) * e - 30 * Math.sin(Math.PI * e));
      card.alpha = p < 0.8 ? 1 : 1 - (p - 0.8) / 0.2;
    });
  }

  private burst(x: number, y: number, color: string, radius: number): void {
    for (let i = 0; i < 8; i += 1) {
      const angle = (Math.PI * 2 * i) / 8;
      const spark = new Graphics().rect(0, 0, 2, 2).fill(color);
      this.add(spark, 600, (p) => {
        spark.x = Math.round(x + Math.cos(angle) * radius * ease(p));
        spark.y = Math.round(y + Math.sin(angle) * radius * 0.6 * ease(p));
        spark.alpha = 1 - p;
      });
    }
  }

  private coin(x: number, y: number, delayMs: number): void {
    const coin = new Graphics().rect(0, 0, 3, 3).fill(COLORS.gold).rect(1, 1, 1, 1).fill("#b8860b");
    const to = { x: TILL_POS.x + 11, y: TILL_POS.y + 2 };
    this.add(coin, 700, (p) => {
      coin.x = Math.round(x + (to.x - x) * p);
      coin.y = Math.round(y + (to.y - y) * p - 40 * Math.sin(Math.PI * p));
    }, delayMs);
  }

  private beam(stallX: number): void {
    const beam = new Graphics()
      .moveTo(LIGHTHOUSE_X, 33).lineTo(stallX - 6, 108).lineTo(stallX + 6, 108).lineTo(LIGHTHOUSE_X, 33)
      .fill({ color: "#fff3b0", alpha: 0.35 });
    this.add(beam, 900, (p) => {
      beam.alpha = p < 0.3 ? p / 0.3 : 1 - (p - 0.3) / 0.7;
    });
  }

  private spark(agentId: AgentId): void {
    const x = STALL_X[agentId] + (Math.random() * 24 - 12);
    const s = new Graphics().rect(0, 0, 1, 1).fill(COLORS.gold);
    this.add(s, 500, (p) => {
      s.x = Math.round(x);
      s.y = Math.round(104 - 16 * p);
      s.alpha = 1 - p;
    });
  }

  // ---------------------------------------------------------------- loop
  private finishAll(): void {
    for (const tween of this.tweens.splice(0)) tween.node.destroy();
  }

  private readonly tick = (ticker: Ticker): void => {
    this.sparkClock += ticker.deltaMS;
    if (this.sparkClock >= SPARK_EVERY_MS / this.speed) {
      this.sparkClock = 0;
      for (const agentId of this.working) this.spark(agentId);
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
