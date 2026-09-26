from __future__ import annotations

import json

import pytest

from abyss import config
from abyss.contract import validate_stream
from abyss.events import EventStream
from abyss.ledger import cost_usd
from abyss.llm import LLM, LLMError
from abyss.market import run_job
from abyss.orchestrator import TaskSpec
from abyss.reputation import ReputationStore


class FailingLLM:
    def __init__(self, base: LLM, *, failed_bid: bool = False, failed_work: bool = False):
        self.base = base
        self.failed_bid = failed_bid
        self.failed_work = failed_work
        self.bid_failed = False

    async def call(self, **kwargs):
        if (
            self.failed_bid
            and kwargs["purpose"] == "bid"
            and kwargs["agent_id"] == "haiku"
            and not self.bid_failed
        ):
            self.bid_failed = True
            _record_failure(kwargs)
            raise LLMError("bid failed")
        if self.failed_work and kwargs["purpose"] == "work" and kwargs["task_id"] == "t1":
            _record_failure(kwargs)
            raise LLMError("work failed")
        return await self.base.call(**kwargs)


def _record_failure(kwargs: dict) -> None:
    model = kwargs["nominal_model"]
    kwargs["ledger"].record(
        task_id=kwargs.get("task_id"),
        agent_id=kwargs.get("agent_id") if kwargs["purpose"] in {"bid", "work"} else None,
        purpose=kwargs["purpose"],
        model=model,
        input_tokens=0,
        output_tokens=0,
        cache_read_input_tokens=0,
        cache_creation_input_tokens=0,
        cost_usd=cost_usd(model, 0, 0),
        ok=False,
        stop_reason=None,
        error="stub failure",
        duration_ms=0,
    )


def _tasks() -> list[TaskSpec]:
    return [
        TaskSpec("t1", "research", "Research", "Find accurate facts", []),
        TaskSpec("t2", "writing", "Write", "Write a concise answer", ["t1"]),
    ]


async def _run(monkeypatch, tmp_path, *, llm=None, fixed_agent_id=None, tasks=None):
    monkeypatch.setenv("ABYSS_FAKE_LLM", "1")
    monkeypatch.setenv("ABYSS_FAKE_DELAY", "0")
    ledger_path = tmp_path / "ledger.jsonl"
    monkeypatch.setenv("ABYSS_LEDGER_PATH", str(ledger_path))
    events: list[dict] = []

    async def sink(event: dict) -> None:
        events.append(event)

    rep = ReputationStore()
    stream = EventStream(sink)
    await stream.hello(rep)
    result = await run_job(
        "Explain a fact, then check it.",
        stream=stream,
        llm=llm or LLM(),
        rep=rep,
        fixed_agent_id=fixed_agent_id,
        tasks=tasks,
    )
    return events, result, rep, ledger_path


@pytest.mark.asyncio
async def test_fake_run_validates_and_ledger_matches(monkeypatch, tmp_path) -> None:
    events, result, _, ledger_path = await _run(monkeypatch, tmp_path)

    validate_stream(events)
    task_count = len(
        next(event for event in events if event["type"] == "job_split")["data"]["tasks"]
    )
    # split + 3 bids, 1 work and 1 review per task + the main agent's assemble call
    assert len(result.ledger.entries()) == 1 + 3 * task_count + task_count + task_count + 1
    assembled = next(event for event in events if event["type"] == "assembled")
    assert result.final["filename"] == assembled["data"]["filename"]
    assert result.final["deliverable"]
    lines = [json.loads(line) for line in ledger_path.read_text().splitlines()]
    total = round(
        sum(line["cost_usd"] for line in lines if line["job_id"] == result.job_id),
        6,
    )
    assert result.final["total_cost_usd"] == total


@pytest.mark.asyncio
async def test_one_failed_bid_does_not_stop_task(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("ABYSS_FAKE_LLM", "1")
    monkeypatch.setenv("ABYSS_FAKE_DELAY", "0")
    llm = FailingLLM(LLM(), failed_bid=True)
    events, result, _, _ = await _run(
        monkeypatch, tmp_path, llm=llm, tasks=_tasks()
    )

    validate_stream(events)
    failed_bids = [
        event for event in events if event["type"] == "bid" and not event["data"]["ok"]
    ]
    assert len(failed_bids) == 1
    assert result.status == "ok"
    assert any(event["type"] == "done" for event in events)


@pytest.mark.asyncio
async def test_work_failure_retries_then_continues(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("ABYSS_FAKE_LLM", "1")
    monkeypatch.setenv("ABYSS_FAKE_DELAY", "0")
    llm = FailingLLM(LLM(), failed_work=True)
    events, result, rep, _ = await _run(
        monkeypatch, tmp_path, llm=llm, tasks=_tasks()
    )

    validate_stream(events)
    assert result.status == "partial"
    winner = next(
        event["data"]["agent_id"]
        for event in events
        if event["type"] == "won" and event["data"]["task_id"] == "t1"
    )
    assert rep.get(winner, "research") == 1.0
    assert sum(
        entry.purpose == "work" and entry.task_id == "t1"
        for entry in result.ledger.entries()
    ) == 2


@pytest.mark.asyncio
async def test_fixed_agent_skips_bids(monkeypatch, tmp_path) -> None:
    events, result, _, _ = await _run(
        monkeypatch,
        tmp_path,
        fixed_agent_id="sonnet",
        tasks=_tasks(),
    )

    validate_stream(events)
    assert not any(entry.purpose == "bid" for entry in result.ledger.entries())
    won = [event for event in events if event["type"] == "won"]
    assert won and all(event["data"]["mode"] == "fixed" for event in won)
    assert not any(event["type"] == "rep_update" for event in events)
