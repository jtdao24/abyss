import type { AbyssEvent, ClientMsg } from "../contract";

export interface EventSource {
  start(onEvent: (event: AbyssEvent) => void): void;
  stop(): void;
  /** Returns false when the message could not be sent (e.g. disconnected). */
  send?(message: ClientMsg): boolean;
}
