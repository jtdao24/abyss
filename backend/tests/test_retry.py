from __future__ import annotations

from fastapi.testclient import TestClient

from abyss.contract import validate_stream
from abyss.market import RetryPlan
from abyss.orchestrator import TaskSpec

from test_server import _receive_through_final, _server

JOB = {"type": "start_job", "job": "Explain why the sky is blue in 80 words, then fact-check it."}

PLAN = [
    TaskSpec("t1", "research", "Find facts", "b1", []),
    TaskSpec("t2", "writing", "Write it", "b2", ["t1"]),
    TaskSpec("t3", "checking", "Check it", "b3", ["t1", "t2"]),
]


def test_retry_plan_redoes_named_and_unfinished_tasks() -> None:
    plan = RetryPlan(PLAN, {"t1": "facts", "t2": "draft"}, redo=["t2"], kept={})
    assert [t.task_id for t in PLAN if plan.redoes(t.task_id)] == ["t2", "t3"]  # t3 never finished


def _run_first_job(ws) -> tuple[dict, list[dict]]:
    hello = ws.receive_json()
    ws.send_json(JOB)
    return hello, _receive_through_final(ws, hello)


def test_retry_redoes_one_task_and_keeps_the_rest(monkeypatch, tmp_path) -> None:
    server = _server(monkeypatch, tmp_path)
    with TestClient(server.app) as client:
        with client.websocket_connect("/ws") as ws:
            hello, first = _run_first_job(ws)
            job_id = first[-1]["job_id"]
            saved = client.get(f"/api/sessions/{job_id}").json()
            assert [t["task_id"] for t in saved["plan"]] == ["t1", "t2", "t3"]
            assert set(saved["outputs"]) == {"t1", "t2", "t3"}

            ws.send_json({"type": "retry_task", "session_id": job_id, "task_ids": ["t2"]})
            second = _receive_through_final(ws, ws.receive_json())
            retry_id = second[-1]["job_id"]
            retried = client.get(f"/api/sessions/{retry_id}").json()

    validate_stream(first)
    validate_stream([hello, *second])
    split = next(e for e in second if e["type"] == "job_split")["data"]
    assert [t["task_id"] for t in split["tasks"]] == ["t1", "t2", "t3"]  # the same plan
    assert split["usage"]["cost_usd"] == 0  # no new plan: nothing spent splitting
    won = {e["data"]["task_id"]: e["data"]["mode"] for e in second if e["type"] == "won"}
    assert won == {"t1": "fixed", "t2": "auction", "t3": "fixed"}
    assert {e["data"]["task_id"] for e in second if e["type"] == "bid"} == {"t2"}  # one auction
    kept_done = next(e for e in second if e["type"] == "done" and e["data"]["task_id"] == "t1")["data"]
    assert kept_done["output"] == saved["outputs"]["t1"] and kept_done["usage"]["cost_usd"] == 0
    assert second[-1]["data"]["deliverable"]
    assert second[-1]["data"]["status"] == "ok"
    # The retry saves the whole merged plan, so it can be retried in turn.
    assert retried["retry_of"] == job_id
    assert [t["task_id"] for t in retried["plan"]] == ["t1", "t2", "t3"]
    assert retried["outputs"]["t1"] == saved["outputs"]["t1"]
    graded = {t["task_id"]: t["grade"] for t in retried["final"]["tasks"]}
    assert graded["t1"] == {t["task_id"]: t["grade"] for t in saved["final"]["tasks"]}["t1"]
    assert set(retried["outputs"]) == {"t1", "t2", "t3"}


def test_retry_refusals(monkeypatch, tmp_path) -> None:
    server = _server(monkeypatch, tmp_path)
    with TestClient(server.app) as client:
        with client.websocket_connect("/ws") as ws:
            hello, first = _run_first_job(ws)
            job_id = first[-1]["job_id"]
            for message, expected in [
                ({"type": "retry_task", "session_id": job_id, "task_ids": ["t9"]}, "no task t9"),
                ({"type": "retry_task", "session_id": "j_nothere", "task_ids": ["t1"]}, "isn't saved"),
                ({"type": "retry_task", "session_id": job_id, "task_ids": []}, "needs task_ids"),
            ]:
                ws.send_json(message)
                reply = ws.receive_json()
                assert reply["type"] == "error" and expected in reply["data"]["message"], reply

    record = server.sessions.get(job_id)
    record.pop("plan")
    server.sessions._write(job_id, record)
    start, error = server._retry_start({"session_id": job_id, "task_ids": ["t1"]})
    assert start is None and "/rerun" in error


def test_a_retry_can_wait_in_the_queue(monkeypatch, tmp_path) -> None:
    server = _server(monkeypatch, tmp_path, delay="0.01")
    with TestClient(server.app) as client:
        with client.websocket_connect("/ws") as ws:
            hello, first = _run_first_job(ws)
            job_id = first[-1]["job_id"]
            ws.send_json(JOB)
            ws.send_json({"type": "retry_task", "session_id": job_id, "task_ids": ["t3"], "queue": True})
            running = _receive_through_final(ws, ws.receive_json())
            retried = _receive_through_final(ws, ws.receive_json())
    assert {e["data"]["task_id"] for e in retried if e["type"] == "bid"} == {"t3"}
    assert running[-1]["job_id"] != retried[-1]["job_id"]
