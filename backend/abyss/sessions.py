"""Saved sessions: one JSON file per job under runs/sessions/.

The server feeds every market event through `SessionStore.observe`. It keeps
what the page needs to list and reopen past sessions (job text, provider,
status, latest stats, final result), plus an all-time usage summary built from
the ledger. Event shapes are untouched; this only listens.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

from . import config
from .ledger import cost_usd


def sessions_dir() -> Path:
    override = os.getenv("ABYSS_SESSIONS_DIR")
    return Path(override) if override else config.ledger_path().parent / "sessions"


def _safe_id(job_id: str) -> bool:
    return job_id.startswith("j_") and job_id[2:].isalnum() and len(job_id) <= 40


class SessionStore:
    def __init__(self, directory: Path | None = None) -> None:
        self.directory = directory or sessions_dir()
        # (job text, provider, budget) until the job's job_split names it
        self._pending: tuple[str, str | None, float | None] | None = None

    # ------------------------------------------------------------- writing
    def expect(self, job_text: str, provider: str | None, budget_usd: float | None = None) -> None:
        """The market is about to start this job; its job_id arrives with job_split."""
        self._pending = (job_text, provider, budget_usd)

    def observe(self, event: dict) -> None:
        job_id = event.get("job_id")
        kind = event.get("type")
        if not job_id or not _safe_id(job_id):
            return
        try:
            if kind == "job_split":
                text, provider, budget = self._pending or ("", None, None)
                self._pending = None
                self._write(job_id, {
                    "id": job_id,
                    "job_text": text,
                    "provider": provider or config.provider(),
                    "budget_usd": budget,
                    "status": "running",
                    "started_at": time.time(),
                    "stats": None,
                    "final": None,
                })
            elif kind == "stats":
                self._update(job_id, stats=event.get("data"))
            elif kind == "final":
                data = event.get("data") or {}
                self._update(job_id, final=data, status=data.get("status", "ok"), finished_at=time.time())
            elif kind == "error" and (event.get("data") or {}).get("fatal"):
                self._update(job_id, status="error", finished_at=time.time())
        except OSError:
            pass  # saving history must never stop the market

    def _path(self, job_id: str) -> Path:
        return self.directory / f"{job_id}.json"

    def _write(self, job_id: str, record: dict) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)
        tmp = self._path(job_id).with_suffix(".tmp")
        tmp.write_text(json.dumps(record), encoding="utf-8")
        tmp.replace(self._path(job_id))

    def _update(self, job_id: str, **fields) -> None:
        record = self.get(job_id)
        if record is None:
            return
        record.update(fields)
        self._write(job_id, record)

    # ------------------------------------------------------------- reading
    def get(self, job_id: str) -> dict | None:
        if not _safe_id(job_id):
            return None
        try:
            return json.loads(self._path(job_id).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def all(self) -> list[dict]:
        records = []
        if self.directory.exists():
            for path in self.directory.glob("j_*.json"):
                try:
                    records.append(json.loads(path.read_text(encoding="utf-8")))
                except (OSError, ValueError):
                    continue
        return sorted(records, key=lambda r: r.get("started_at") or 0, reverse=True)

    def summaries(self) -> list[dict]:
        out = []
        for r in self.all():
            final = r.get("final") or {}
            stats = r.get("stats") or {}
            out.append({
                "id": r["id"],
                "job_text": r.get("job_text", ""),
                "provider": r.get("provider"),
                "status": r.get("status"),
                "cost_usd": final.get("total_cost_usd", stats.get("total_cost_usd", 0.0)),
                "mean_grade": final.get("mean_grade"),
                "filename": final.get("filename"),
                "started_at": r.get("started_at"),
                "duration_ms": final.get("duration_ms"),
                "budget_usd": r.get("budget_usd"),
            })
        return out


# ------------------------------------------------------------------ usage
def premium_price(provider_name: str) -> tuple[float, float] | None:
    """What a token costs at the provider's top tier (VENDOR 1's model)."""
    top = config.provider_tiers(provider_name)["premium"]
    return config.PRICES.get(top)


def usage_summary(store: SessionStore, ledger_file: Path | None = None, recent: int = 30) -> dict:
    """All-time spend from the ledger, grouped by job and joined with sessions.

    `premium_equiv_usd` reprices the vendors' bid and work tokens at the job
    provider's top-tier price (split/review/assemble cost the same either way):
    an estimate of what routing every task to VENDOR 1 would have cost.
    """
    ledger_file = ledger_file or config.ledger_path()
    sessions = {s["id"]: s for s in store.all()}
    jobs: dict[str, dict] = {}
    totals = {"cost_usd": 0.0, "input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0, "calls": 0}
    by_purpose: dict[str, dict] = {}
    by_provider: dict[str, dict] = {}
    try:
        lines = ledger_file.read_text(encoding="utf-8").splitlines()
    except OSError:
        lines = []
    for line in lines:
        try:
            e = json.loads(line)
            job_id = e["job_id"]
            cost = float(e.get("cost_usd") or 0.0)
            inp, out = int(e.get("input_tokens") or 0), int(e.get("output_tokens") or 0)
        except (ValueError, KeyError, TypeError):
            continue
        if job_id not in sessions:
            continue  # smoke tests, headless CLI runs: not a session
        provider_name = sessions[job_id].get("provider") or config.provider()
        job = jobs.setdefault(job_id, {"job_id": job_id, "cost_usd": 0.0, "premium_equiv_usd": 0.0, "provider": provider_name})
        job["cost_usd"] += cost
        purpose = e.get("purpose", "?")
        if purpose in ("bid", "work") and (price := premium_price(provider_name)):
            job["premium_equiv_usd"] += (inp * price[0] + out * price[1]) / 1_000_000
        else:
            job["premium_equiv_usd"] += cost
        totals["cost_usd"] += cost
        totals["input_tokens"] += inp
        totals["output_tokens"] += out
        totals["cache_read_tokens"] += int(e.get("cache_read_input_tokens") or 0)
        totals["calls"] += 1
        bucket = by_purpose.setdefault(purpose, {"cost_usd": 0.0, "calls": 0})
        bucket["cost_usd"] += cost
        bucket["calls"] += 1
        pbucket = by_provider.setdefault(provider_name, {"cost_usd": 0.0, "jobs": 0})
        pbucket["cost_usd"] += cost

    for job in jobs.values():
        by_provider[job["provider"]]["jobs"] += 1
        session = sessions[job["job_id"]]
        job["mean_grade"] = (session.get("final") or {}).get("mean_grade")
        job["started_at"] = session.get("started_at")
        job["job_text"] = session.get("job_text", "")
    ordered = sorted(jobs.values(), key=lambda j: j.get("started_at") or 0)
    grades = [j["mean_grade"] for j in ordered if j["mean_grade"] is not None]
    return {
        "totals": {**totals, "jobs": len(ordered), "premium_equiv_usd": sum(j["premium_equiv_usd"] for j in ordered)},
        "mean_grade": (sum(grades) / len(grades)) if grades else None,
        "by_purpose": by_purpose,
        "by_provider": by_provider,
        "recent": ordered[-recent:],
    }


__all__ = ["SessionStore", "sessions_dir", "usage_summary", "premium_price", "cost_usd"]
