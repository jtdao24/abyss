from __future__ import annotations

import importlib

import pytest
from fastapi.testclient import TestClient

from abyss.contract import validate_stream
from abyss.events import EventStream
from abyss.llm import LLM
from abyss.market import Guidance, run_job
from abyss.orchestrator import TaskSpec
from abyss.reputation import ReputationStore


class RecordingLLM:
    """Fake LLM that remembers every prompt, optionally steering mid-job."""

    def __init__(self, on_work=None):
        self.base: LLM | None = None  # created on first call, after fake mode is switched on
        self.calls: list[dict] = []
        self.on_work = on_work

    async def call(self, **kwargs):
        self.base = self.base or LLM()
        self.calls.append(kwargs)
        result = await self.base.call(**kwargs)
        if kwargs["purpose"] == "work" and self.on_work:
            self.on_work(kwargs)
        return result


def _tasks() -> list[TaskSpec]:
    return [
        TaskSpec("t1", "research", "Research", "Find accurate facts", []),
        TaskSpec("t2", "writing", "Write", "Write a concise answer", ["t1"]),
    ]


async def _run(monkeypatch, tmp_path, llm, guidance, fixed_agent_id=None):
    monkeypatch.setenv("ABYSS_FAKE_LLM", "1")
    monkeypatch.setenv("ABYSS_FAKE_DELAY", "0")
    monkeypatch.setenv("ABYSS_LEDGER_PATH", str(tmp_path / "ledger.jsonl"))
    events: list[dict] = []

    async def sink(event: dict) -> None:
        events.append(event)

    stream = EventStream(sink)
    await stream.hello(ReputationStore())
    await run_job("Explain a fact.", stream=stream, llm=llm, rep=ReputationStore(),
                  tasks=_tasks(), guidance=guidance, fixed_agent_id=fixed_agent_id)
    return events


@pytest.mark.asyncio
async def test_agent_note_reaches_that_agents_work_and_its_review(monkeypatch, tmp_path) -> None:
    llm = RecordingLLM()
    guidance = Guidance()
    guidance.add("sonnet", "Cite one source.")
    await _run(monkeypatch, tmp_path, llm, guidance, fixed_agent_id="sonnet")
    work = [c for c in llm.calls if c["purpose"] == "work"]
    review = [c for c in llm.calls if c["purpose"] == "review"]
    assert work and all("Cite one source." in c["user"] for c in work)
    assert review and all("Cite one source." in c["user"] for c in review)


@pytest.mark.asyncio
async def test_agent_note_does_not_reach_other_agents(monkeypatch, tmp_path) -> None:
    llm = RecordingLLM()
    guidance = Guidance()
    guidance.add("opus", "Only for opus.")
    await _run(monkeypatch, tmp_path, llm, guidance, fixed_agent_id="haiku")
    assert not any("Only for opus." in c["user"] for c in llm.calls)


@pytest.mark.asyncio
async def test_job_note_reaches_every_agent(monkeypatch, tmp_path) -> None:
    llm = RecordingLLM()
    guidance = Guidance()
    guidance.add("job", "Keep it under 50 words.")
    await _run(monkeypatch, tmp_path, llm, guidance, fixed_agent_id="haiku")
    assert all("Keep it under 50 words." in c["user"] for c in llm.calls if c["purpose"] in ("work", "review"))


@pytest.mark.asyncio
async def test_note_sent_mid_job_applies_from_the_next_work(monkeypatch, tmp_path) -> None:
    guidance = Guidance()

    def steer_after_first_work(kwargs):
        if kwargs["task_id"] == "t1":
            guidance.add("job", "Change of plan: bullet points.")

    llm = RecordingLLM(on_work=steer_after_first_work)
    await _run(monkeypatch, tmp_path, llm, guidance, fixed_agent_id="haiku")
    work = {c["task_id"]: c["user"] for c in llm.calls if c["purpose"] == "work"}
    assert "Change of plan" not in work["t1"]
    assert "Change of plan" in work["t2"]


def _server(monkeypatch, tmp_path, delay: str):
    monkeypatch.setenv("ABYSS_FAKE_LLM", "1")
    monkeypatch.setenv("ABYSS_FAKE_DELAY", delay)
    monkeypatch.setenv("ABYSS_LEDGER_PATH", str(tmp_path / "ledger.jsonl"))
    monkeypatch.setenv("ABYSS_REP_PATH", str(tmp_path / "reputation.json"))
    import abyss.server

    return importlib.reload(abyss.server)


def test_server_acknowledges_steer_during_a_job(monkeypatch, tmp_path) -> None:
    server = _server(monkeypatch, tmp_path, "0.05")
    with TestClient(server.app) as client, client.websocket_connect("/ws") as ws:
        events = [ws.receive_json()]
        ws.send_json({"type": "start_job", "job": "Explain tides, then check it."})
        ws.send_json({"type": "steer", "target": "opus", "note": "  Be brief.  "})
        while events[-1]["type"] != "final":
            events.append(ws.receive_json())
    steered = [e for e in events if e["type"] == "steered"]
    assert steered and steered[0]["data"] == {"target": "opus", "note": "Be brief."}
    validate_stream(events)


def test_server_rejects_steer_without_a_job(monkeypatch, tmp_path) -> None:
    server = _server(monkeypatch, tmp_path, "0")
    with TestClient(server.app) as client, client.websocket_connect("/ws") as ws:
        ws.receive_json()
        ws.send_json({"type": "steer", "target": "job", "note": "hello"})
        reply = ws.receive_json()
        ws.send_json({"type": "steer", "target": "gpt", "note": "hello"})
        bad_target = ws.receive_json()
    assert reply["type"] == "error" and "no job" in reply["data"]["message"]
    assert bad_target["type"] == "error" and "target" in bad_target["data"]["message"]
