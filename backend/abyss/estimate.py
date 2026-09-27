"""What a session will probably cost, before it starts (no AI calls).

Same per-call token assumptions as the experiment's --estimate. A session is
a split, then per task: the bids (all written by the budget tier), the
winner's work and a review, then the main agent packages the result. The range
runs from "the premium vendor stays on standby and the budget vendor wins every
task" to "the premium vendor steps in and wins every task".
"""
from __future__ import annotations

from . import config
from .ledger import cost_usd

TYPICAL_TASKS = 3
EST_WORK = (1000, 1500)  # input, output tokens (reasoning included)
EST_SMALL = (600, 300)   # a bid, a review, the split
EST_ASSEMBLE = (1500, 1200)


def _price(provider_name: str, tier: str, tokens: tuple[int, int]) -> float:
    return cost_usd(config.served_model(provider_name, tier), *tokens)


def estimate_session(provider_name: str | None = None, tasks: int = TYPICAL_TASKS) -> dict:
    name = provider_name if provider_name in config.PROVIDERS else config.provider()
    tiers = [agent.model for agent in config.AGENTS]
    bid = _price(name, config.BID_MODEL, EST_SMALL)
    review = _price(name, config.REVIEWER_MODEL, EST_SMALL)
    fixed = _price(name, config.ORCHESTRATOR_MODEL, EST_SMALL) + _price(name, config.ORCHESTRATOR_MODEL, EST_ASSEMBLE)
    work = sorted(_price(name, tier, EST_WORK) for tier in tiers)
    low = fixed + tasks * (2 * bid + review + work[0])  # the premium vendor on standby
    high = fixed + tasks * (3 * bid + review + work[-1])
    return {
        "provider": name,
        "test_mode": not config.real_models(),
        "tasks": tasks,
        "low_usd": round(low, 4),
        "high_usd": round(high, 4),
        "calls": 2 + tasks * 5,
    }
