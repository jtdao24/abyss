// The title card over the boardwalk: stays up long enough to read (and while the
// art loads), then fades away. A click or any key skips it.
import { useEffect, useState } from "react";

const MIN_SHOW_MS = 3000;
const FADE_MS = 700;
const TITLE = "ABYSS MARKET";

export function Intro({ ready, onDone }: { ready: boolean; onDone?: () => void }) {
  const [minDone, setMinDone] = useState(false);
  const [skipped, setSkipped] = useState(false);
  const [gone, setGone] = useState(false);
  const leaving = ready && (minDone || skipped);

  useEffect(() => {
    const t = window.setTimeout(() => setMinDone(true), MIN_SHOW_MS);
    const skip = () => setSkipped(true);
    window.addEventListener("keydown", skip, { once: true });
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("keydown", skip);
    };
  }, []);

  useEffect(() => {
    if (!leaving) return;
    const t = window.setTimeout(() => {
      setGone(true);
      onDone?.();
    }, FADE_MS);
    return () => window.clearTimeout(t);
  }, [leaving]);

  if (gone) return null;
  return (
    <div className={`intro ${leaving ? "leaving" : ""}`} onPointerDown={() => setSkipped(true)} role="presentation">
      <h1 aria-label={TITLE}>
        {[...TITLE].map((ch, i) => (
          <span key={i} style={{ animationDelay: `${150 + i * 70}ms` }}>{ch === " " ? " " : ch}</span>
        ))}
      </h1>
      <p>AI agents bid for your work</p>
      <div className="intro-bar"><i /></div>
      <small>{ready ? "Click anywhere to start" : "Setting up the boardwalk…"}</small>
    </div>
  );
}
