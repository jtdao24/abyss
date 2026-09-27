import { describe, expect, it } from "vitest";

import type { AbyssEvent } from "../contract";
import { eventKey, nearBottom } from "./terminalScroll";

describe("nearBottom", () => {
  it("is true at the bottom and within the slack", () => {
    expect(nearBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 })).toBe(true);
    expect(nearBottom({ scrollHeight: 1000, scrollTop: 530, clientHeight: 400 })).toBe(true);
  });

  it("is false once the user has scrolled up past the slack", () => {
    expect(nearBottom({ scrollHeight: 1000, scrollTop: 400, clientHeight: 400 })).toBe(false);
  });

  it("treats content shorter than the view as the bottom", () => {
    expect(nearBottom({ scrollHeight: 200, scrollTop: 0, clientHeight: 400 })).toBe(true);
  });
});

describe("eventKey", () => {
  const hello = () => ({ v: 1, seq: 0, t: 0, job_id: null, type: "hello", data: {} }) as unknown as AbyssEvent;

  it("gives the same event object the same key every time", () => {
    const ev = hello();
    expect(eventKey(ev)).toBe(eventKey(ev));
  });

  it("tells apart events that share a seq (every connection's hello is seq 0)", () => {
    expect(eventKey(hello())).not.toBe(eventKey(hello()));
  });
});
