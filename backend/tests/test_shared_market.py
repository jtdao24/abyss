from __future__ import annotations

import importlib
import time

import pytest
from fastapi.testclient import TestClient

from abyss.contract import validate_stream
from abyss.events import EventStream
from abyss.llm import LLM, LLMError
from abyss.market import run_job
from abyss.orchestrator import TaskSpec
from abyss.reputation import ReputationStore


def _server(monkeypatch, tmp_path, delay: str):
    monkeypatch.setenv("ABYSS_FAKE_LLM", "1")
    monkeypatch.setenv("ABYSS_FAKE_DELAY", delay)
    monkeypatch.setenv("ABYSS_LEDGER_PATH", str(tmp_path / "ledger.jsonl"))
    monkeypatch.setenv("ABYSS_REP_PATH", str(tmp_path / "reputation.json"))
    import abyss.server

    return importlib.reload(abyss.server)


def _until_final(ws, events: list[dict]) -> list[dict]:
    while not events or events[-1]["type"] != "final":
        events.append(ws.receive_json())
    return events


def test_a_viewer_sees_the_job_another_connection_started(monkeypatch, tmp_path) -> None:
    server = _server(monkeypatch, tmp_path, "0.01")
    with TestClient(server.app) as client:
        with client.websocket_connect("/ws") as viewer, client.websocket_connect("/ws") as chat:
            seen = [viewer.receive_json()]
            chat.receive_json()
            chat.send_json({"type": "start_job", "job": "Write a Python function that reverses a string."})
            _until_final(viewer, seen)
    validate_stream(seen)
    final = seen[-1]["data"]
    assert final["filename"] == "solution.py" and final["deliverable"]
    assert any(e["type"] == "assembled" for e in seen)


def test_a_late_viewer_is_caught_up_and_a_closed_chat_does_not_cancel(monkeypatch, tmp_path) -> None:
    server = _server(monkeypatch, tmp_path, "0.05")
    with TestClient(server.app) as client:
        with client.websocket_connect("/ws") as chat:
            chat.receive_json()
            chat.send_json({"type": "start_job", "job": "Explain tides, then check it."})
            first = chat.receive_json()  # the job has started
            assert first["type"] == "job_split"
        # the chat window is gone; the job keeps running
        time.sleep(0.2)
        with client.websocket_connect("/ws") as late:
            events = _until_final(late, [late.receive_json()])
    assert events[0]["type"] == "hello"
    assert events[1]["type"] == "job_split"  # caught up from the start of the job
    validate_stream(events)


class FailingAssembly:
    def __init__(self):
        self.base: LLM | None = None

    async def call(self, **kwargs):
        if kwargs["purpose"] == "assemble":
            raise LLMError("assembly failed")
        self.base = self.base or LLM()
        return await self.base.call(**kwargs)


@pytest.mark.asyncio
async def test_failed_assembly_still_delivers_the_last_draft(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("ABYSS_FAKE_LLM", "1")
    monkeypatch.setenv("ABYSS_FAKE_DELAY", "0")
    monkeypatch.setenv("ABYSS_LEDGER_PATH", str(tmp_path / "ledger.jsonl"))
    events: list[dict] = []

    async def sink(event: dict) -> None:
        events.append(event)

    stream = EventStream(sink)
    await stream.hello(ReputationStore())
    tasks = [TaskSpec("t1", "research", "R", "Find facts", []), TaskSpec("t2", "writing", "W", "Write it", ["t1"])]
    result = await run_job("Explain a fact.", stream=stream, llm=FailingAssembly(), rep=ReputationStore(), tasks=tasks)
    validate_stream(events)
    assert any(e["type"] == "error" and "assemble" in e["data"]["message"] for e in events)
    assert result.final["filename"] == "abyss_result.md"
    assert result.final["deliverable_task_id"] == "t2"
