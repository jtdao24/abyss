// Poll something every `ms` while the page is visible. A hidden tab (another
// tab in front, a minimized window) makes no requests; coming back polls once
// right away so the numbers are fresh.
import { useEffect, useRef, type DependencyList } from "react";

export function usePolling(poll: () => void, ms: number, deps: DependencyList = []): void {
  const latest = useRef(poll);
  latest.current = poll;
  useEffect(() => {
    latest.current();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") latest.current();
    }, ms);
    const onVisible = () => {
      if (document.visibilityState === "visible") latest.current();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, ...deps]);
}
