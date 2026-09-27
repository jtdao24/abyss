"""Saved sessions: one JSON file per job under runs/sessions/.

The server feeds every market event through `SessionStore.observe`. It keeps
what the page needs to list and reopen past sessions (job text, provider,
status, latest stats, final result), plus an all-time usage summary built from
the ledger. Event shapes are untouched; this only listens.
"""
from __future__ import annotations

import contextlib
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
        # (job text, provider, budget, attachment names, tool servers) until the job's job_split names it
        self._pending: tuple[str, str | None, float | None, list[str], list[str] | None] | None = None

    # ------------------------------------------------------------- writing
    def expect(
        self,
        job_text: str,
        provider: str | None,
        budget_usd: float | None = None,
        attachments: list[str] | None = None,
        tools: list[str] | None = None,
        attachment_ids: list[str] | None = None,
    ) -> None:
        """The market is about to start this job; its job_id arrives with job_split."""
        self._pending = (job_text, provider, budget_usd, list(attachments or []), tools)
        self._pending_ids = list(attachment_ids or [])
        self._pending_retry: str | None = None

    def expect_retry(self, source_id: str) -> None:
        """The next job redoes tasks of `source_id` (it runs the same plan)."""
        self._pending_retry = source_id

    def observe(self, event: dict) -> None:
        job_id = event.get("job_id")
        kind = event.get("type")
        if not job_id or not _safe_id(job_id):
            return
        try:
            if kind == "job_split":
                text, provider, budget, attached, tool_servers = self._pending or ("", None, None, [], None)
                self._pending = None
                retry_of, self._pending_retry = getattr(self, "_pending_retry", None), None
                self._write(job_id, {
                    "id": job_id,
                    "job_text": text,
                    "provider": provider or config.provider(),
                    "budget_usd": budget,
                    "attachments": attached,
                    "tools": tool_servers,  # MCP servers allowed (None: all)
                    "attachment_ids": getattr(self, "_pending_ids", []),  # so a re-run gets them too
                    "plan": (event.get("data") or {}).get("tasks") or [],  # so single tasks can be retried
                    "outputs": {},  # task id -> finished work (from done events)
                    "retry_of": retry_of,
                    "bids": {},          # agent -> bids actually placed
                    "rep_updates": [],   # every reputation change, in order
                    "status": "running",
                    "started_at": time.time(),
                    "stats": None,
                    "final": None,
                })
            elif kind == "stats":
                self._update(job_id, stats=event.get("data"))
            elif kind == "bid" and (event.get("data") or {}).get("ok"):
                record = self.get(job_id)
                if record is not None:
                    agent = event["data"]["agent_id"]
                    bids = record.setdefault("bids", {})
                    bids[agent] = bids.get(agent, 0) + 1
                    self._write(job_id, record)
            elif kind == "done":
                record = self.get(job_id)
                if record is not None:
                    record.setdefault("outputs", {})[event["data"]["task_id"]] = event["data"]["output"]
                    self._write(job_id, record)
            elif kind == "rep_update":
                record = self.get(job_id)
                if record is not None:
                    data = event["data"]
                    record.setdefault("rep_updates", []).append({
                        "t": event.get("t"), "task_id": data["task_id"], "agent_id": data["agent_id"],
                        "task_type": data["task_type"], "old": data["old"], "new": data["new"], "ratio": data["ratio"],
                    })
                    self._write(job_id, record)
            elif kind == "final":
                data = event.get("data") or {}
                self._update(job_id, final=data, status=data.get("status", "ok"), finished_at=time.time())
            elif kind == "error" and (event.get("data") or {}).get("fatal"):
                self._update(job_id, status="error", finished_at=time.time())
        except OSError:
            pass  # saving history must never stop the market

    def mark_stopped(self, job_id: str | None) -> None:
        """A job cancelled by Stop (it never reached its final)."""
        if job_id and _safe_id(job_id):
            record = self.get(job_id)
            if record is not None and record.get("status") == "running":
                with contextlib.suppress(OSError):
                    self._update(job_id, status="stopped", finished_at=time.time())

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
                "attachments": r.get("attachments") or [],
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


__all__ = ["SessionStore", "sessions_dir", "usage_summary", "vendor_stats", "premium_price", "cost_usd"]


def vendor_stats(store: SessionStore, reputation_now: dict[str, dict[str, float]] | None = None) -> dict:
    """Each vendor across every saved session: bids, wins, win rate, grades vs
    what it promised, and its reputation per task type over time (oldest first)."""
    agents = {a.agent_id: a for a in config.AGENTS}
    out: dict[str, dict] = {
        agent_id: {
            "agent_id": agent_id,
            "bids": 0,
            "wins": 0,
            "win_rate": None,
            "graded": 0,
            "avg_grade": None,
            "avg_promised": None,
            "by_type": {t: {"wins": 0, "avg_grade": None} for t in config.TASK_TYPES},
            "reputation": (reputation_now or {}).get(agent_id, {}),
            "history": {t: [] for t in config.TASK_TYPES},
        }
        for agent_id in agents
    }
    grades: dict[str, list[int]] = {a: [] for a in agents}
    promised: dict[str, list[int]] = {a: [] for a in agents}
    type_grades: dict[tuple[str, str], list[int]] = {}
    for record in sorted(store.all(), key=lambda r: r.get("started_at") or 0):
        if "bids" in record:
            for agent_id, count in (record.get("bids") or {}).items():
                if agent_id in out:
                    out[agent_id]["bids"] += count
        else:
            # Saved before bids were counted: every vendor bid on each auctioned task.
            auctioned = sum(1 for t in ((record.get("final") or {}).get("tasks") or []) if t.get("agent_id"))
            for stats in out.values():
                stats["bids"] += auctioned
        for task in ((record.get("final") or {}).get("tasks") or []):
            agent_id = task.get("agent_id")
            if agent_id not in out:
                continue
            out[agent_id]["wins"] += 1
            out[agent_id]["by_type"][task["type"]]["wins"] += 1
            if task.get("grade") is not None:
                grades[agent_id].append(task["grade"])
                type_grades.setdefault((agent_id, task["type"]), []).append(task["grade"])
                if task.get("promised_quality") is not None:
                    promised[agent_id].append(task["promised_quality"])
        for update in record.get("rep_updates") or []:
            if update["agent_id"] in out:
                out[update["agent_id"]]["history"][update["task_type"]].append(
                    {"job_id": record["id"], "t": record.get("started_at"), "value": update["new"], "ratio": update["ratio"]}
                )
    for agent_id, stats in out.items():
        if stats["bids"]:
            stats["win_rate"] = stats["wins"] / stats["bids"]
        if grades[agent_id]:
            stats["graded"] = len(grades[agent_id])
            stats["avg_grade"] = sum(grades[agent_id]) / len(grades[agent_id])
        if promised[agent_id]:
            stats["avg_promised"] = sum(promised[agent_id]) / len(promised[agent_id])
        for task_type in config.TASK_TYPES:
            values = type_grades.get((agent_id, task_type))
            if values:
                stats["by_type"][task_type]["avg_grade"] = sum(values) / len(values)
    return {"vendors": out, "sessions": len(store.all())}
