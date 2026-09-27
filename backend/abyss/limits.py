"""Spending limits across all sessions: per day, week and month.

Limits live in runs/limits.json (no secrets). Spend is summed from the ledger
by timestamp, in local time: today since midnight, this week since Monday,
this month since the 1st. At 80% of a limit the page warns; at 100% new
sessions are refused, and a running session is hard-capped to what's left
(its Ledger budget), so spend never passes a limit.
"""
from __future__ import annotations

import datetime as dt
import json
import os
from pathlib import Path

from . import config

PERIODS = ("day", "week", "month")
WARN_AT = 0.8
MAX_LIMIT_USD = 10_000
PERIOD_LABEL = {"day": "today", "week": "this week", "month": "this month"}


def limits_path() -> Path:
    override = os.getenv("ABYSS_LIMITS_PATH")
    return Path(override) if override else config.ledger_path().parent / "limits.json"


def load() -> dict[str, float | None]:
    try:
        raw = json.loads(limits_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raw = {}
    out: dict[str, float | None] = {}
    for period in PERIODS:
        value = raw.get(period) if isinstance(raw, dict) else None
        ok = isinstance(value, (int, float)) and not isinstance(value, bool) and 0 < value <= MAX_LIMIT_USD
        out[period] = float(value) if ok else None
    return out


def save(updates: dict) -> dict[str, float | None]:
    """Set limits from {period: dollars | null}; unknown keys are refused."""
    current = load()
    for period, value in updates.items():
        if period not in PERIODS:
            raise ValueError(f"unknown period {period!r}: use day, week or month")
        if value is None:
            current[period] = None
        elif isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 < value <= MAX_LIMIT_USD:
            raise ValueError(f"the {period} limit must be more than $0 and at most ${MAX_LIMIT_USD:,}")
        else:
            current[period] = float(value)
    path = limits_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(current, indent=2) + "\n", encoding="utf-8")
    return current


def period_starts(now: dt.datetime) -> dict[str, dt.datetime]:
    day = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return {"day": day, "week": day - dt.timedelta(days=day.weekday()), "month": day.replace(day=1)}


def period_resets(now: dt.datetime) -> dict[str, dt.datetime]:
    starts = period_starts(now)
    month = starts["month"]
    next_month = month.replace(year=month.year + 1, month=1) if month.month == 12 else month.replace(month=month.month + 1)
    return {"day": starts["day"] + dt.timedelta(days=1), "week": starts["week"] + dt.timedelta(days=7), "month": next_month}


def spent(now: dt.datetime | None = None, ledger_file: Path | None = None) -> dict[str, float]:
    """Dollars recorded in the ledger since the start of each period."""
    now = now or dt.datetime.now()
    starts = {p: s.timestamp() for p, s in period_starts(now).items()}
    totals = dict.fromkeys(PERIODS, 0.0)
    try:
        lines = (ledger_file or config.ledger_path()).read_text(encoding="utf-8").splitlines()
    except OSError:
        return totals
    for line in lines:
        try:
            entry = json.loads(line)
            ts, cost = float(entry["ts"]), float(entry.get("cost_usd") or 0.0)
        except (ValueError, KeyError, TypeError):
            continue
        for period in PERIODS:
            if ts >= starts[period]:
                totals[period] += cost
    return totals


def status(now: dt.datetime | None = None) -> dict:
    """What the spend meter shows, and whether new sessions may start."""
    now = now or dt.datetime.now()
    limits = load()
    used = spent(now)
    resets = period_resets(now)
    periods = []
    for period in PERIODS:
        limit = limits[period]
        pct = (used[period] / limit) if limit else None
        state = "none" if limit is None else "over" if used[period] >= limit else "warn" if pct >= WARN_AT else "ok"
        periods.append({
            "period": period,
            "limit": limit,
            "spent": round(used[period], 6),
            "pct": pct,
            "state": state,
            "resets_at": resets[period].timestamp(),
        })
    left = [p["limit"] - p["spent"] for p in periods if p["limit"] is not None]
    blocking = next((p for p in periods if p["state"] == "over"), None)
    return {
        "periods": periods,
        "remaining_usd": max(0.0, min(left)) if left else None,
        "blocked": blocking is not None,
        "message": _blocked_message(blocking) if blocking else None,
    }


def _blocked_message(p: dict) -> str:
    resets = dt.datetime.fromtimestamp(p["resets_at"])
    when = resets.strftime("%a %b %d") if p["period"] != "day" else "midnight"
    return (
        f"Spending limit reached: ${p['spent']:.2f} of ${p['limit']:.2f} {PERIOD_LABEL[p['period']]}. "
        f"Raise the limit or wait until {when}."
    )


def job_budget(session_budget: float | None) -> float | None:
    """The hard cap for a new job: its own budget or what the limits leave, whichever is lower."""
    remaining = status()["remaining_usd"]
    if remaining is None:
        return session_budget
    return remaining if session_budget is None else min(session_budget, remaining)
