import { describe, expect, it } from "vitest";

import fixture from "../../public/fixtures/fake_run.json";
import type { AbyssEvent } from "../contract";
import { initialState, reduce, type MarketState } from "../state/reducer";
import { sceneModel } from "./model";

const events = fixture as AbyssEvent[];

function stateAfter(predicate: (ev: AbyssEvent) => boolean): MarketState {
  let state = initialState;
  for (const ev of events) {
    state = reduce(state, ev);
    if (predicate(ev)) return state;
  }
  throw new Error("predicate never matched");
}

describe("sceneModel", () => {
  it("shows bid bubbles and a thinking bubble while t1 is open", () => {
    const state = stateAfter((ev) => ev.type === "bid" && ev.data.agent_id === "haiku");
    const model = sceneModel(state);
    const bubbles = Object.fromEntries(model.stalls.map((s) => [s.agentId, s.bubble?.text]));
    expect(bubbles).toEqual({ haiku: "Q8 0.22¢", sonnet: "...", opus: "..." });
    expect(model.stalls.every((s) => !s.winner)).toBe(true);
    expect(model.banner).toBe("T1 RESEARCH - Gather the tide physics");
  });

  it("flags the winner and shows it working", () => {
    const state = stateAfter((ev) => ev.type === "working" && ev.data.task_id === "t2");
    const model = sceneModel(state);
    const sonnet = model.stalls.find((s) => s.agentId === "sonnet")!;
    expect(sonnet.winner).toBe(true);
    expect(sonnet.bubble).toEqual({ text: "WORKING", tone: "working" });
    expect(model.stalls.filter((s) => s.winner)).toHaveLength(1);
    expect(model.cards.map((c) => c.glyph)).toEqual(["6", "~", ""]);
  });

  it("marks an overpromise as a bad review", () => {
    const state = stateAfter((ev) => ev.type === "graded" && ev.data.task_id === "t1");
    expect(sceneModel(state).review).toEqual({ text: "T1 6/10", tone: "bad" });
  });

  it("ends with every card graded, the final banner, and the fixture total", () => {
    const model = sceneModel(events.reduce(reduce, initialState));
    expect(model.cards.map((c) => c.status)).toEqual(["graded", "graded", "graded"]);
    expect(model.finalBanner).toBe("JOB OK - GRADE 8 - $0.0693");
    expect(model.spent).toBe("SPENT $0.0693");
    expect(model.review).toEqual({ text: "T3 9/10", tone: "ok" });
  });

  it("renders an empty market before any job", () => {
    const model = sceneModel(reduce(initialState, events[0]));
    expect(model.stalls).toHaveLength(3);
    expect(model.cards).toEqual([]);
    expect(model.banner).toBe("WAITING FOR A JOB");
  });
});
