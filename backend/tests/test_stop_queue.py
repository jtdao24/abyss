from __future__ import annotations

import json

from fastapi.testclient import TestClient

from abyss.contract import validate_stream
from abyss.ledger import Ledger
from abyss.market import Guidance

from test_server import _receive_through_final, _server

JOB = {"type": "start_job", "job": "Explain why the sky is blue in 80 words, then fact-check it."}
LOCAL = {"Origin": "http://localhost:8000"}


def test_guidance_stop_caps_the_ledger_at_what_was_spent(tmp_path) -> None:
    ledger = Ledger("j_x", None, budget_usd=None)
    ledger.record(
        task_id=None, agent_id=None, purpose="split", model="gpt-5-mini", input_tokens=10, output_tokens=10,
        cache_read_input_tokens=0, cache_creation_input_tokens=0, cost_usd=0.01, ok=True, stop_reason=None,
        error=None, duration_ms=1,
    )
    guidance = Guidance()
    guidance.ledger = ledger
    guidance.stop()
    assert guidance.stopped
    assert ledger.remaining_usd() == 0


def test_stop_ends_the_job_with_a_valid_final(monkeypatch, tmp_path) -> None:
    server = _server(monkeypatch, tmp_path, delay="0.05")
    with TestClient(server.app) as client:
        with client.websocket_connect("/ws") as ws:
            hello = ws.receive_json()
            ws.send_json(JOB)
            first = ws.receive_json()
            assert first["type"] == "job_split"
            ws.send_json({"type": "stop_job"})
            events = _receive_through_final(ws, hello)[1:]
            events = [hello, first, *events]
            assert client.get("/api/queue").json()["running"] is False

    validate_stream(events)
    stopped = [e for e in events if e["type"] == "error" and "stopped by you" in e["data"]["message"]]
    assert stopped, "later tasks should say they were stopped"
    assert any(e["type"] == "steered" and "Stop" in e["data"]["note"] for e in events)
    final = events[-1]["data"]
    graded = [t for t in final["tasks"] if t.get("grade") is not None]
    assert len(graded) < len(final["tasks"]) or not final["tasks"]


def test_stop_with_nothing_running_is_refused(monkeypatch, tmp_path) -> None:
    server = _server(monkeypatch, tmp_path)
    with TestClient(server.app) as client:
        with client.websocket_connect("/ws") as ws:
            ws.receive_json()
            ws.send_json({"type": "stop_job"})
            reply = ws.receive_json()
            assert reply["type"] == "error" and "no job is running" in reply["data"]["message"]


def test_queued_session_starts_after_the_current_one(monkeypatch, tmp_path) -> None:
    server = _server(monkeypatch, tmp_path, delay="0.01")
    with TestClient(server.app) as client:
        with client.websocket_connect("/ws") as ws:
            hello = ws.receive_json()
            ws.send_json(JOB)
            ws.send_json({**JOB, "job": "Write a haiku about the sea.", "queue": True})
            first = _receive_through_final(ws, hello)
            second = _receive_through_final(ws, ws.receive_json())
            assert client.get("/api/queue").json()["queue"] == []

    assert not any(e["type"] == "error" and "already running" in e["data"]["message"] for e in first)
    validate_stream(first)
    validate_stream([hello, *second])
    split = next(e for e in second if e["type"] == "job_split")
    assert split["data"]["job_text"] == "Write a haiku about the sea."
    assert first[-1]["job_id"] != second[-1]["job_id"]


def test_queue_can_be_listed_and_edited(monkeypatch, tmp_path) -> None:
    server = _server(monkeypatch, tmp_path, delay="0.05")
    with TestClient(server.app) as client:
        with client.websocket_connect("/ws") as ws:
            hello = ws.receive_json()
            ws.send_json(JOB)
            ws.send_json({**JOB, "job": "second", "queue": True})
            ws.send_json({**JOB, "job": "third", "queue": True})
            ws.send_json({**JOB, "job": "bad", "queue": "yes"})
            deadline = 0
            while len(client.get("/api/queue").json()["queue"]) < 2 and deadline < 200:
                deadline += 1
            listed = client.get("/api/queue").json()
            assert [q["job"] for q in listed["queue"]] == ["second", "third"]
            assert client.delete(f"/api/queue/{listed['queue'][0]['id']}", headers={"Origin": "https://evil.example"}).status_code == 403
            after = client.delete(f"/api/queue/{listed['queue'][0]['id']}", headers=LOCAL).json()
            assert [q["job"] for q in after["queue"]] == ["third"]
            assert client.delete("/api/queue/q999", headers=LOCAL).status_code == 404
            ws.send_json({"type": "stop_job"})
            events = _receive_through_final(ws, hello)
    refusals = [e for e in events if e["type"] == "error" and e["job_id"] is None]
    assert any("already running" in e["data"]["message"] for e in refusals)  # queue must be exactly true


def test_sessions_record_attachment_ids_for_reruns(tmp_path) -> None:
    from abyss.sessions import SessionStore

    store = SessionStore(tmp_path)
    store.expect("job", "openai", None, ["notes.pdf"], None, ["a_123"])
    store.observe({"job_id": "j_abc123", "type": "job_split", "data": {}})
    record = store.get("j_abc123")
    assert record["attachment_ids"] == ["a_123"]
    assert json.dumps(record)
    store.mark_stopped("j_abc123")
    assert store.get("j_abc123")["status"] == "stopped"
