from __future__ import annotations

import importlib

import pytest
from fastapi.testclient import TestClient

from abyss.contract import validate_stream
from abyss.estimate import estimate_session
from abyss.events import EventStream
from abyss.llm import LLM
from abyss.market import run_job
from abyss.reputation import ReputationStore


@pytest.fixture
def fake(monkeypatch, tmp_path):
    monkeypatch.setenv("ABYSS_FAKE_LLM", "1")
    monkeypatch.setenv("ABYSS_FAKE_DELAY", "0")
    monkeypatch.setenv("ABYSS_LEDGER_PATH", str(tmp_path / "ledger.jsonl"))
    monkeypatch.setenv("ABYSS_SESSIONS_DIR", str(tmp_path / "sessions"))
    return tmp_path


async def _run(budget_usd: float | None) -> list[dict]:
    events: list[dict] = []

    async def sink(event: dict) -> None:
        events.append(event)

    stream = EventStream(sink)
    rep = ReputationStore(None)
    await stream.hello(rep)  # a valid stream starts with hello
    await run_job(
        "Explain tides, then check it.", stream=stream, llm=LLM(), rep=rep, budget_usd=budget_usd,
    )
    return events


async def test_a_budget_stops_new_tasks_without_spending(fake) -> None:
    unlimited = await _run(None)
    first_task_cost = next(e for e in unlimited if e["type"] == "final")["data"]["tasks"][0]["cost_usd"]

    events = await _run(0.000001)  # anything spent (the split) is over this cap
    validate_stream(events)  # still a valid market stream
    final = events[-1]["data"]
    assert final["status"] == "partial"
    assert all(task["grade"] is None for task in final["tasks"])
    budget_errors = [e for e in events if e["type"] == "error" and "budget reached" in e["data"]["message"]]
    assert len(budget_errors) == len(final["tasks"])
    bids = [e for e in events if e["type"] == "bid"]
    assert bids and all(not b["data"]["ok"] and b["data"]["usage"] is None for b in bids)  # no calls
    assert first_task_cost > 0 and final["total_cost_usd"] < next(
        e for e in unlimited if e["type"] == "final"
    )["data"]["total_cost_usd"]


async def test_no_budget_runs_every_task(fake) -> None:
    final = (await _run(None))[-1]["data"]
    assert final["status"] == "ok"
    assert all(task["grade"] is not None for task in final["tasks"])


def test_estimate_gives_a_range_per_ai(monkeypatch) -> None:
    monkeypatch.setenv("ABYSS_REAL_MODELS", "1")
    openai = estimate_session("openai")
    meta = estimate_session("meta")
    assert 0 < openai["low_usd"] < openai["high_usd"]  # budget vs premium winners
    assert meta["provider"] == "meta" and meta["low_usd"] > 0
    monkeypatch.setenv("ABYSS_REAL_MODELS", "0")
    test_mode = estimate_session("openai")
    assert test_mode["test_mode"] and test_mode["high_usd"] < openai["high_usd"]  # all on gpt-5-mini


def test_budget_is_validated_and_estimate_is_served(fake, monkeypatch) -> None:
    import abyss.server

    server = importlib.reload(abyss.server)
    with TestClient(server.app) as client:
        assert client.get("/api/estimate?provider=openai").json()["provider"] == "openai"
        with client.websocket_connect("/ws") as ws:
            ws.receive_json()
            ws.send_json({"type": "start_job", "job": "Say hi.", "budget_usd": -1})
            assert "budget_usd" in ws.receive_json()["data"]["message"]
            ws.send_json({"type": "start_job", "job": "Say hi.", "budget_usd": 0.5})
            assert ws.receive_json()["type"] == "job_split"
            while ws.receive_json()["type"] != "final":
                pass
        listed = client.get("/api/sessions").json()
        assert listed[0]["budget_usd"] == 0.5
