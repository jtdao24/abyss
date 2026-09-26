import type { AbyssEvent, ClientMsg } from "../contract";

export interface EventSource {
  start(onEvent: (event: AbyssEvent) => void): void;
  stop(): void;
  send?(message: ClientMsg): void;
}
