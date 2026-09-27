from __future__ import annotations

import json

from abyss.ledger import Ledger, cost_usd


def _record_fixture_usage(ledger: Ledger, events: list[dict]) -> None:
    purposes = {
        "job_split": "split",
        "bid": "bid",
        "done": "work",
        "graded": "review",
        "assembled": "assemble",
    }
    for event in events:
        purpose = purposes.get(event["type"])
        if purpose is None:
            continue
        data = event["data"]
        usage = data["usage"]
        ledger.record(
            task_id=data.get("task_id"),
            agent_id=data.get("agent_id") if purpose in {"bid", "work"} else None,
            purpose=purpose,
            model=usage["model"],
            input_tokens=usage["input_tokens"],
            output_tokens=usage["output_tokens"],
            cache_read_input_tokens=0,
            cache_creation_input_tokens=0,
            cost_usd=usage["cost_usd"],
            ok=True,
            stop_reason="end_turn",
            error=None,
            duration_ms=usage["duration_ms"],
        )


def test_cost_usd() -> None:
    assert cost_usd("gpt-5", 1000, 1000) == 0.01125  # 1000 in at $1.25/M + 1000 out at $10/M


def test_fixture_stats(fixture_events: list[dict]) -> None:
    ledger = Ledger("j_7f3a91c2", None)
    _record_fixture_usage(ledger, fixture_events)
    tasks_won = {"haiku": 0, "sonnet": 0, "opus": 0}
    for event in fixture_events:
        if event["type"] == "won":
            tasks_won[event["data"]["agent_id"]] += 1
    expected = [
        event["data"] for event in fixture_events if event["type"] == "stats"
    ][-1]
    assert ledger.stats(tasks_won) == expected


def test_record_appends_one_jsonl_line(tmp_path) -> None:
    path = tmp_path / "ledger.jsonl"
    ledger = Ledger("j_deadbeef", path)
    fields = {
        "task_id": "t1",
        "agent_id": "haiku",
        "purpose": "work",
        "model": "gpt-5-mini",
        "input_tokens": 10,
        "output_tokens": 20,
        "cache_read_input_tokens": 0,
        "cache_creation_input_tokens": 0,
        "cost_usd": cost_usd("gpt-5-mini", 10, 20),
        "ok": True,
        "stop_reason": "end_turn",
        "error": None,
        "duration_ms": 100,
    }
    first = ledger.record(**fields)
    second = ledger.record(**fields)

    lines = path.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 2
    assert [json.loads(line)["id"] for line in lines] == ["c_0001", "c_0002"]
    assert [first.id, second.id] == ["c_0001", "c_0002"]
    assert len(ledger.entries()) == 2
