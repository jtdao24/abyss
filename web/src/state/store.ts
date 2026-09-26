import type { AbyssEvent } from "../contract";
import { initialState, reduce, type MarketState } from "./reducer";

type Listener = () => void;

export interface MarketStore {
  getState(): MarketState;
  dispatch(event: AbyssEvent): void;
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
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const store = createStore();
