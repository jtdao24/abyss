import { describe, expect, it, vi } from "vitest";

import fixture from "../../public/fixtures/fake_run.json";
import type { AbyssEvent } from "../contract";
import { initialState, reduce } from "./reducer";

describe("market reducer", () => {
  it("reduces the canonical fixture to the expected final state", () => {
    const state = (fixture as AbyssEvent[]).reduce(reduce, initialState);

    expect(state.taskOrder).toEqual(["t1", "t2", "t3"]);
    expect(state.tasks.t1.status).toBe("graded");
    expect(state.tasks.t1.winner).toBe("haiku");
    expect(state.tasks.t2.status).toBe("graded");
    expect(state.tasks.t2.winner).toBe("sonnet");
    expect(state.tasks.t3.status).toBe("graded");
    expect(state.tasks.t3.winner).toBe("opus");
    expect(state.stats?.total_cost_usd).toBe(0.06928);
    expect(state.final?.total_cost_usd).toBe(0.06928);
    expect(state.agents.haiku?.reputation.research).toBe(0.925);
    expect(state.agents.opus?.reputation.checking).toBe(0.97);
    expect(state.log).toHaveLength(37);
    expect(state.history).toHaveLength(1);
    expect(state.history[0].final.total_cost_usd).toBe(0.06928);
    expect(state.history[0].jobText).toMatch(/two high tides/);
    expect(state.resultCollected).toBe(false);
  });

  it("keeps steering notes with the job they belong to", () => {
    const steered = {
      v: 1, seq: 99, t: 5, job_id: "j_7f3a91c2", type: "steered",
      data: { target: "sonnet", note: "Cite a source." },
    } as AbyssEvent;
    const state = reduce(initialState, steered);
    expect(state.steering).toEqual([{ jobId: "j_7f3a91c2", target: "sonnet", note: "Cite a source." }]);
  });

  it("ignores and reports unknown event types", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const unknown = {
      v: 1,
      seq: 0,
      t: 0,
      job_id: null,
      type: "future_event",
      data: {},
    } as unknown as AbyssEvent;

    const state = reduce(initialState, unknown);

    expect(state.log).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith("Unknown Abyss event type", "future_event");
    warn.mockRestore();
  });
});
