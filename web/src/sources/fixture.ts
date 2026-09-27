import type { AbyssEvent } from "../contract";
import type { MarketSource } from "./types";

export class FixtureSource implements MarketSource {
  private active = false;
  private controller: AbortController | null = null;

  constructor(
    private readonly url: string,
    private readonly speed: number,
  ) {}

  start(onEvent: (event: AbyssEvent) => void): void {
    this.stop();
    this.active = true;
    this.controller = new AbortController();
    void this.replay(onEvent, this.controller.signal).catch((error: unknown) => {
      if (this.active) {
        console.error("Fixture replay failed", error);
      }
    });
  }

  stop(): void {
    this.active = false;
    this.controller?.abort();
    this.controller = null;
  }

  private async replay(
    onEvent: (event: AbyssEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await fetch(this.url, { signal });
    if (!response.ok) {
      throw new Error(`Fixture request failed with ${response.status}`);
    }
    const events = (await response.json()) as AbyssEvent[];
    const speed = Number.isFinite(this.speed) && this.speed > 0 ? this.speed : 1;
    let previousTime = 0;
    for (const event of events) {
      const delay = Math.min(3000, Math.max(0, event.t - previousTime)) / speed;
      previousTime = event.t;
      await wait(delay, signal);
      if (!this.active) return;
      onEvent(event);
    }
  }
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timer);
        reject(new DOMException("Replay stopped", "AbortError"));
      },
      { once: true },
    );
  });
}
