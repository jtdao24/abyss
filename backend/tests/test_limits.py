from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from abyss import limits, server

NOW = dt.datetime(2026, 9, 23, 15, 0)  # a Wednesday afternoon
LOCAL = {"Origin": "http://localhost:8000"}


@pytest.fixture
def files(tmp_path: Path, monkeypatch) -> Path:
    ledger = tmp_path / "ledger.jsonl"
    monkeypatch.setenv("ABYSS_LEDGER_PATH", str(ledger))
    monkeypatch.setenv("ABYSS_LIMITS_PATH", str(tmp_path / "limits.json"))
    return ledger


def spend(ledger: Path, when: dt.datetime, cost: float) -> None:
    with ledger.open("a", encoding="utf-8") as f:
        f.write(json.dumps({"ts": when.timestamp(), "job_id": "j_x", "cost_usd": cost}) + "\n")


def test_spend_is_summed_per_period(files: Path) -> None:
    spend(files, NOW - dt.timedelta(hours=2), 0.50)          # today
    spend(files, NOW - dt.timedelta(days=1), 0.25)           # Tuesday: this week
    spend(files, NOW - dt.timedelta(days=4), 1.00)           # last Saturday: this month only
    spend(files, dt.datetime(2026, 8, 31, 12), 5.00)         # last month
    files.open("a").write("not json\n")
    used = limits.spent(NOW)
    assert used == pytest.approx({"day": 0.50, "week": 0.75, "month": 1.75})


def test_status_warns_then_blocks(files: Path) -> None:
    assert limits.status(NOW)["remaining_usd"] is None
    limits.save({"day": 1.0, "month": 10})
    spend(files, NOW, 0.85)
    status = limits.status(NOW)
    day = status["periods"][0]
    assert day["state"] == "warn" and not status["blocked"]
    assert status["remaining_usd"] == pytest.approx(0.15)
    spend(files, NOW, 0.20)
    status = limits.status(NOW)
    assert status["blocked"] and "today" in status["message"]
    assert status["remaining_usd"] == 0.0


def test_job_budget_takes_the_lower_cap(files: Path) -> None:
    assert limits.job_budget(0.5) == 0.5
    limits.save({"week": 2.0})
    spend(files, dt.datetime.now(), 1.7)
    assert limits.job_budget(None) == pytest.approx(0.3)
    assert limits.job_budget(0.1) == 0.1
    assert limits.job_budget(5) == pytest.approx(0.3)


def test_save_validates(files: Path) -> None:
    with pytest.raises(ValueError):
        limits.save({"year": 5})
    with pytest.raises(ValueError):
        limits.save({"day": -1})
    with pytest.raises(ValueError):
        limits.save({"day": True})
    assert limits.save({"day": 3})["day"] == 3.0
    assert limits.save({"day": None})["day"] is None


def test_period_resets() -> None:
    resets = limits.period_resets(dt.datetime(2026, 12, 31, 9))
    assert resets["day"] == dt.datetime(2027, 1, 1)
    assert resets["week"] == dt.datetime(2027, 1, 4)  # the next Monday
    assert resets["month"] == dt.datetime(2027, 1, 1)


def test_api_sets_limits_and_blocks_new_sessions(files: Path) -> None:
    spend(files, dt.datetime.now(), 0.30)
    with TestClient(server.app) as client:
        assert client.post("/api/limits", json={"day": 0.25}, headers={"Origin": "https://evil.example"}).status_code == 403
        assert client.post("/api/limits", json={"day": "lots"}, headers=LOCAL).status_code == 400
        status = client.post("/api/limits", json={"day": 0.25}, headers=LOCAL).json()
        assert status["blocked"]
        assert client.get("/api/limits").json()["periods"][0]["limit"] == 0.25
        with client.websocket_connect("/ws") as ws:
            ws.send_json({"type": "start_job", "job": "hello"})
            error = ws.receive_json()
            while error["type"] != "error":  # hello, then the last job's events replayed
                error = ws.receive_json()
            assert error["type"] == "error" and "Spending limit reached" in error["data"]["message"]
