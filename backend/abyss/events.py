from __future__ import annotations

import secrets
import time
from dataclasses import asdict
from typing import Awaitable, Callable

from . import config
from .contract import validate_event
from .reputation import ReputationStore


Sink = Callable[[dict], Awaitable[None]]


class EventStream:
    def __init__(self, sink: Sink):
        self.sink = sink
        self.seq = 0
        self.job_id: str | None = None
        self._started: float | None = None

    async def hello(self, rep: ReputationStore) -> None:
        await self.emit("hello", hello_data(rep), job_id=None)

    def start_job(self, job_id: str) -> None:
        self.job_id = job_id
        self._started = time.monotonic()

    async def emit(
        self,
        type: str,
        data: dict,
        job_id: str | None = ...,
    ) -> None:
        await self.sink(self.stamp(type, data, job_id))

    def stamp(self, type: str, data: dict, job_id: str | None = ...) -> dict:
        """Build and validate the next event without sending it."""
        resolved_job_id = self.job_id if job_id is ... else job_id
        elapsed = 0
        if resolved_job_id is not None and self._started is not None:
            elapsed = round((time.monotonic() - self._started) * 1000)
        event = {
            "v": 1,
            "seq": self.seq,
            "t": elapsed,
            "job_id": resolved_job_id,
            "type": type,
            "data": data,
        }
        validate_event(event)
        self.seq += 1
        return event


def hello_data(rep: ReputationStore) -> dict:
    return {
        # The stalls as they run for the default AI (e.g. GPT-5 mini / GPT-5).
        "agents": config.agents_for(),
        "reputation": rep.snapshot(),
        "config": {
            "price_weight": config.PRICE_WEIGHT,
            "rep_init": config.REP_INIT,
            "rep_alpha": config.REP_ALPHA,
            "task_types": config.TASK_TYPES,
            "real_models": config.real_models(),
            "fake_llm": config.fake_llm(),
            "orchestrator_model": config.tier_model(config.ORCHESTRATOR_MODEL),
            "reviewer_model": config.tier_model(config.REVIEWER_MODEL),
        },
    }


def new_job_id() -> str:
    return "j_" + secrets.token_hex(4)
