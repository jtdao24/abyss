from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Literal

from . import config
from .config import AGENTS, PRICES


Purpose = Literal["split", "bid", "work", "review", "assemble"]
PURPOSES: tuple[Purpose, ...] = ("split", "bid", "work", "review", "assemble")


def cost_usd(
    model: str,
    input_tokens: int,
    output_tokens: int,
    cache_read: int = 0,
    cache_write: int = 0,
) -> float:
    if model in config.TIERS:  # a tier: price it at the default AI's model for it
        model = config.tier_model(model)
    input_price, output_price = PRICES.get(model, config.FALLBACK_PRICE)
    cost = (
        input_tokens * input_price
        + output_tokens * output_price
        + cache_read * input_price * 0.1
        + cache_write * input_price * 1.25
    ) / 1_000_000
    return round(cost, 6)


@dataclass(frozen=True)
class LedgerEntry:
    id: str
    ts: float
    job_id: str
    task_id: str | None
    agent_id: str | None
    purpose: Purpose
    model: str
    input_tokens: int
    output_tokens: int
    cache_read_input_tokens: int
    cache_creation_input_tokens: int
    cost_usd: float
    ok: bool
    stop_reason: str | None
    error: str | None
    duration_ms: int


class Ledger:
    def __init__(self, job_id: str, path: Path | None, budget_usd: float | None = None):
        self.job_id = job_id
        self.path = path
        # A hard cap for the whole job: the LLM gateway refuses calls (and caps
        # each call's output tokens) so recorded spend never passes it.
        self.budget_usd = budget_usd
        self._entries: list[LedgerEntry] = []

    def remaining_usd(self) -> float | None:
        return None if self.budget_usd is None else self.budget_usd - self.total_cost()

    def record(self, **fields: object) -> LedgerEntry:
        entry = LedgerEntry(
            id=f"c_{len(self._entries) + 1:04d}",
            ts=time.time(),
            job_id=self.job_id,
            **fields,
        )
        self._entries.append(entry)
        if self.path is not None:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(asdict(entry), separators=(",", ":")) + "\n")
        return entry

    def entries(self) -> list[LedgerEntry]:
        return list(self._entries)

    def stats(self, tasks_won: dict[str, int]) -> dict:
        by_purpose = {
            purpose: {"cost_usd": 0.0, "calls": 0} for purpose in PURPOSES
        }
        by_agent = {
            agent.agent_id: {
                "cost_usd": 0.0,
                "input_tokens": 0,
                "output_tokens": 0,
                "calls": 0,
                "tasks_won": tasks_won.get(agent.agent_id, 0),
            }
            for agent in AGENTS
        }

        for entry in self._entries:
            purpose_stats = by_purpose[entry.purpose]
            purpose_stats["cost_usd"] += entry.cost_usd
            purpose_stats["calls"] += 1

            if entry.purpose in ("bid", "work") and entry.agent_id is not None:
                agent_stats = by_agent[entry.agent_id]
                agent_stats["cost_usd"] += entry.cost_usd
                agent_stats["input_tokens"] += entry.input_tokens
                agent_stats["output_tokens"] += entry.output_tokens
                agent_stats["calls"] += 1

        for purpose_stats in by_purpose.values():
            purpose_stats["cost_usd"] = round(purpose_stats["cost_usd"], 6)
        for agent_stats in by_agent.values():
            agent_stats["cost_usd"] = round(agent_stats["cost_usd"], 6)

        return {
            "total_cost_usd": self.total_cost(),
            "input_tokens": sum(entry.input_tokens for entry in self._entries),
            "output_tokens": sum(entry.output_tokens for entry in self._entries),
            "calls": len(self._entries),
            "by_purpose": by_purpose,
            "by_agent": by_agent,
        }

    def task_cost(self, task_id: str) -> float:
        return round(
            sum(entry.cost_usd for entry in self._entries if entry.task_id == task_id),
            6,
        )

    def total_cost(self) -> float:
        return round(sum(entry.cost_usd for entry in self._entries), 6)
