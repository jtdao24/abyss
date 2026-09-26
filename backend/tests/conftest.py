from __future__ import annotations

import json
from pathlib import Path

import pytest


@pytest.fixture
def fixture_events() -> list[dict]:
    fixture_path = Path(__file__).parents[2] / "fixtures" / "fake_run.json"
    return json.loads(fixture_path.read_text(encoding="utf-8"))
