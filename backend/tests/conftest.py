from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

# Tests never read a developer's .env (API keys, provider, real models).
os.environ["ABYSS_NO_DOTENV"] = "1"
# ...nor start a developer's MCP servers (mcp.json).
os.environ["ABYSS_MCP_CONFIG"] = str(Path(__file__).parent / "no-mcp.json")
# Tests default to OpenAI; the Meta tests pick their provider explicitly.
os.environ["ABYSS_PROVIDER"] = "openai"
# The app runs real models per tier by default; the tests assume cheap test mode
# unless they set ABYSS_REAL_MODELS=1. (They also run fake: no network, no cost.)
os.environ["ABYSS_TEST_MODE"] = "1"


@pytest.fixture
def fixture_events() -> list[dict]:
    fixture_path = Path(__file__).parents[2] / "fixtures" / "fake_run.json"
    return json.loads(fixture_path.read_text(encoding="utf-8"))
