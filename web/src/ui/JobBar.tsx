import { useEffect, useState } from "react";

const DEFAULT_JOB =
  "Write a short explainer (under 150 words) on why most coasts get two high tides a day, and fact-check it.";

interface JobBarProps {
  connected: boolean;
  busy: boolean;
  defaultPriceWeight: number;
  onRun(job: string, priceWeight: number): void;
  onReset(): void;
}

export function JobBar({ connected, busy, defaultPriceWeight, onRun, onReset }: JobBarProps) {
  const [job, setJob] = useState(DEFAULT_JOB);
  const [priceWeight, setPriceWeight] = useState(defaultPriceWeight);

  useEffect(() => setPriceWeight(defaultPriceWeight), [defaultPriceWeight]);

  const trimmed = job.trim();
  const canRun = connected && !busy && trimmed.length > 0 && trimmed.length <= 2000;

  return (
    <form
      className="job-bar"
      onSubmit={(event) => {
        event.preventDefault();
        if (canRun) onRun(trimmed, priceWeight);
      }}
    >
      <textarea
        value={job}
        onChange={(event) => setJob(event.target.value)}
        rows={2}
        maxLength={2000}
        aria-label="Job"
        placeholder="Describe a job for the market…"
      />
      <label className="price-weight">
        <span>Price weight {priceWeight.toFixed(2)}</span>
        <input
          type="range"
          min={0}
          max={5}
          step={0.25}
          value={priceWeight}
          onChange={(event) => setPriceWeight(Number(event.target.value))}
        />
      </label>
      <div className="job-actions">
        <button type="submit" disabled={!canRun}>
          {busy ? "Running…" : "Run"}
        </button>
        <button type="button" disabled={!connected || busy} onClick={onReset}>
          Reset rep
        </button>
      </div>
    </form>
  );
}
