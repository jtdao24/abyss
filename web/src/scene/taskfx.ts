// Little looping props that show what kind of work a vendor is doing:
//   research -> magnifying glass sweeping an open book, question marks rising
//   writing  -> a page filling with lines while a quill scribbles
//   checking -> a clipboard ticking off its boxes
import { Container, Graphics, type Text } from "pixi.js";

import type { TaskType } from "../contract";
import { PALETTE, text } from "./Scene";

const INK = PALETTE.ink;
const PAPER = PALETTE.paper;

export class TaskProp extends Container {
  private readonly dynamic = new Graphics();
  private readonly marks: { t: Text; age: number }[] = [];
  private clock = 0;
  private markClock = 0;

  constructor(private readonly kind: TaskType) {
    super();
    const base = new Graphics();
    if (kind === "research") {
      // open book
      base.poly([-24, -4, 0, -10, 0, 12, -24, 18]).fill(PAPER).stroke({ width: 2, color: INK });
      base.poly([24, -4, 0, -10, 0, 12, 24, 18]).fill(PAPER).stroke({ width: 2, color: INK });
      for (let i = 0; i < 3; i += 1) {
        base.moveTo(-19, -1 + i * 5).lineTo(-5, -5 + i * 5).stroke({ width: 1, color: PALETTE.muted });
        base.moveTo(5, -5 + i * 5).lineTo(19, -1 + i * 5).stroke({ width: 1, color: PALETTE.muted });
      }
    } else if (kind === "writing") {
      base.roundRect(-20, -26, 40, 50, 3).fill(PAPER).stroke({ width: 2, color: INK });
    } else {
      base.roundRect(-20, -26, 40, 52, 4).fill("#b07a45").stroke({ width: 2, color: INK });
      base.roundRect(-16, -20, 32, 42, 2).fill(PAPER);
      base.roundRect(-7, -30, 14, 8, 2).fill(PALETTE.muted).stroke({ width: 1.5, color: INK });
      for (let i = 0; i < 4; i += 1) {
        base.rect(-12, -14 + i * 9, 6, 6).stroke({ width: 1.5, color: INK });
        base.moveTo(-3, -11 + i * 9).lineTo(12, -11 + i * 9).stroke({ width: 1.5, color: PALETTE.muted });
      }
    }
    this.addChild(base, this.dynamic);
  }

  update(deltaMs: number): void {
    this.clock += deltaMs;
    const g = this.dynamic.clear();
    if (this.kind === "research") {
      // magnifier sweeps across the book in a figure eight
      const x = Math.sin(this.clock / 420) * 14;
      const y = Math.sin(this.clock / 210) * 5 - 2;
      g.moveTo(x + 6, y + 6).lineTo(x + 15, y + 15).stroke({ width: 4, color: "#7a4a22", cap: "round" });
      g.circle(x, y, 8).fill({ color: "#bfe6ff", alpha: 0.55 }).stroke({ width: 2.5, color: INK });
      this.markClock += deltaMs;
      if (this.markClock > 700) {
        this.markClock = 0;
        const t = text("?", 14, "#1f5f8b");
        t.position.set((Math.random() - 0.5) * 30, -16);
        this.addChild(t);
        this.marks.push({ t, age: 0 });
      }
    } else if (this.kind === "writing") {
      // lines appear one at a time; the quill rides the current line
      const cycle = 5200;
      const p = (this.clock % cycle) / cycle;
      const lines = 6;
      const done = p * lines;
      for (let i = 0; i < lines; i += 1) {
        const fill = Math.max(0, Math.min(1, done - i));
        if (fill <= 0) break;
        const w = (i === lines - 1 ? 18 : 30) * fill;
        g.moveTo(-15, -18 + i * 7).lineTo(-15 + w, -18 + i * 7).stroke({ width: 1.5, color: INK });
      }
      const line = Math.min(lines - 1, Math.floor(done));
      const lineWidth = line === lines - 1 ? 18 : 30;
      const qx = -15 + lineWidth * Math.min(1, done - line) + Math.sin(this.clock / 60) * 1.5;
      const qy = -18 + line * 7;
      g.poly([qx, qy, qx + 5, qy - 16, qx + 11, qy - 22, qx + 7, qy - 12]).fill("#f3ecd8").stroke({ width: 1.5, color: INK });
      g.moveTo(qx, qy).lineTo(qx + 4, qy - 7).stroke({ width: 1.5, color: INK });
    } else {
      // ticks land in the boxes one after another, then the list resets
      const cycle = 4400;
      const p = (this.clock % cycle) / cycle;
      const ticked = Math.floor(p * 5);
      for (let i = 0; i < Math.min(4, ticked); i += 1) {
        const y = -14 + i * 9;
        g.moveTo(-12, y + 3).lineTo(-9.5, y + 6).lineTo(-5, y - 1).stroke({ width: 2, color: PALETTE.good, cap: "round", join: "round" });
      }
    }
    for (let i = this.marks.length - 1; i >= 0; i -= 1) {
      const m = this.marks[i];
      m.age += deltaMs;
      m.t.y -= deltaMs * 0.02;
      m.t.alpha = 1 - m.age / 1400;
      if (m.age >= 1400) {
        m.t.destroy();
        this.marks.splice(i, 1);
      }
    }
    // a gentle bob so the prop feels busy
    this.pivot.y = Math.sin(this.clock / 300) * 1.5;
  }
}
