from __future__ import annotations

import json
from pathlib import Path

from abyss.chat import ChatState, describe, finish, parse_command, save_deliverable

FIXTURE = json.loads((Path(__file__).parents[2] / "fixtures" / "fake_run.json").read_text())


def test_parse_commands() -> None:
    assert parse_command("Write a sorting function in Python") == ("job", {"job": "Write a sorting function in Python"})
    assert parse_command("/steer 2 use type hints") == ("steer", {"target": "sonnet", "note": "use type hints"})
    assert parse_command("/steer job keep it short") == ("steer", {"target": "job", "note": "keep it short"})
    assert parse_command("/steer 9 hi")[0] == "invalid"
    assert parse_command("/steer 1")[0] == "invalid"
    assert parse_command("/price 2.5") == ("price", {"price_weight": 2.5})
    assert parse_command("/price 99")[0] == "invalid"
    assert parse_command("   ") == ("empty", {})
    assert parse_command("/quit") == ("quit", {})
    assert parse_command("/nope")[0] == "invalid"


def test_save_never_overwrites(tmp_path) -> None:
    first = save_deliverable(tmp_path, "solution.py", "print('a')")
    second = save_deliverable(tmp_path, "solution.py", "print('b')")
    assert first.name == "solution.py" and second.name == "solution (1).py"
    assert first.read_text() == "print('a')\n"


def test_every_fixture_event_reads_well_and_hides_models() -> None:
    state = ChatState()
    lines = [describe(ev, state) for ev in FIXTURE if ev["type"] != "final"]
    text = "\n".join(line for line in lines if line)
    for model in ("haiku", "sonnet", "opus", "Haiku", "Sonnet", "Opus"):
        assert model not in text
    assert "Vendor 1" in text and "Reviewer" in text and "tides_explainer.md" in text


def test_finishing_my_job_saves_the_file(tmp_path) -> None:
    final = FIXTURE[-1]
    state = ChatState(my_job_id=final["job_id"], running=True)
    message = finish(final, state, tmp_path)
    saved = tmp_path / "tides_explainer.md"
    assert saved.exists() and "two high tides" in saved.read_text()
    assert "Your file is ready" in message and not state.running


def test_someone_elses_job_is_not_saved(tmp_path) -> None:
    state = ChatState(my_job_id="j_00000000")
    finish(FIXTURE[-1], state, tmp_path)
    assert list(tmp_path.iterdir()) == []
