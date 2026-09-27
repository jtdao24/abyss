import { describe, expect, it, vi } from "vitest";

import fixture from "../../public/fixtures/fake_run.json";
import type { AbyssEvent } from "../contract";
import { initialState, isReplay, reduce } from "./reducer";

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
    expect(state.stats?.total_cost_usd).toBe(0.062432);
    expect(state.final?.total_cost_usd).toBe(0.062432);
    expect(state.final?.filename).toBe("tides_explainer.md");
    expect(state.agents.haiku?.reputation.research).toBe(0.9);
    expect(state.agents.opus?.reputation.checking).toBe(0.97);
    expect(state.log).toHaveLength(39);
    expect(state.history).toHaveLength(1);
    expect(state.history[0].final.total_cost_usd).toBe(0.062432);
    expect(state.history[0].jobText).toMatch(/two high tides/);
  });

  describe("reconnect replay", () => {
    const events = fixture as AbyssEvent[];
    const hello = events[0];
    const jobEvents = events.filter((e) => e.job_id !== null);
    const steered = {
      v: 1, seq: 1000, t: 5, job_id: jobEvents[0].job_id, type: "steered",
      data: { target: "sonnet", note: "Cite a source." },
    } as AbyssEvent;

    it("drops the finished job's events the server replays after a new hello", () => {
      const before = [...events, steered].reduce(reduce, initialState);
      // The server sends hello, then the last job's events again.
      const after = [hello, ...jobEvents, steered].reduce(reduce, before);

      expect(after.history).toHaveLength(1);
      expect(after.steering).toHaveLength(1);
      expect(after.log).toHaveLength(before.log.length + 1); // just the new hello
      expect(after.jobActive).toBe(false);
      expect(after.final?.total_cost_usd).toBe(0.062432);
    });

    it("knows the job is still running when it reconnects mid-job", () => {
      const cut = jobEvents.findIndex((e) => e.type === "working");
      const before = [hello, ...jobEvents.slice(0, cut)].reduce(reduce, initialState);
      expect(before.jobActive).toBe(true);

      const rejoined = reduce(before, hello);
      expect(rejoined.jobActive).toBe(false); // hello alone can't tell
      const caughtUp = jobEvents.slice(0, cut).reduce(reduce, rejoined);
      expect(caughtUp.jobActive).toBe(true);
      expect(caughtUp.log).toHaveLength(before.log.length + 1);

      // Events we hadn't seen yet still apply as normal.
      const next = reduce(caughtUp, jobEvents[cut]);
      expect(next.tasks[(jobEvents[cut].data as { task_id: string }).task_id].status).toBe("working");
    });

    it("flags replays and nothing else", () => {
      const state = events.slice(0, 5).reduce(reduce, initialState);
      expect(isReplay(state, events[3])).toBe(true);
      expect(isReplay(state, events[5])).toBe(false);
      expect(isReplay(state, hello)).toBe(false);
    });
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
