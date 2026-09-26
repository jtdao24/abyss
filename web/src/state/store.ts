import type { AbyssEvent } from "../contract";
import { collectResult, initialState, reduce, setConnected, type MarketState } from "./reducer";

type Listener = () => void;

export interface MarketStore {
  getState(): MarketState;
  dispatch(event: AbyssEvent): void;
  setConnected(connected: boolean): void;
  collectResult(): void;
  subscribe(listener: Listener): () => void;
}

export function createStore(start: MarketState = initialState): MarketStore {
  let state = start;
  const listeners = new Set<Listener>();
  return {
    getState: () => state,
    dispatch(event) {
      state = reduce(state, event);
      listeners.forEach((listener) => listener());
    },
    setConnected(connected) {
      state = setConnected(state, connected);
      listeners.forEach((listener) => listener());
    },
    collectResult() {
      state = collectResult(state);
      listeners.forEach((listener) => listener());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const store = createStore();
