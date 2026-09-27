from __future__ import annotations

import importlib
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from abyss import config
from abyss.ledger import Ledger
from abyss.llm import LLM, LLMError

SCHEMA = {"type": "object", "properties": {"grade": {"type": "integer"}}, "required": ["grade"]}


class FakeCompletions:
    def __init__(self, content: str | None, finish_reason: str = "stop", refusal: str | None = None) -> None:
        self.content, self.finish_reason, self.refusal = content, finish_reason, refusal
        self.requests: list[dict] = []

    async def create(self, **request):
        self.requests.append(request)
        usage = SimpleNamespace(prompt_tokens=1200, completion_tokens=300, prompt_tokens_details=SimpleNamespace(cached_tokens=200))
        message = SimpleNamespace(content=self.content, refusal=self.refusal)
        return SimpleNamespace(choices=[SimpleNamespace(message=message, finish_reason=self.finish_reason)], usage=usage)


def _client(completions: FakeCompletions):
    return SimpleNamespace(chat=SimpleNamespace(completions=completions))


@pytest.fixture
def real_calls(monkeypatch, tmp_path):
    monkeypatch.delenv("ABYSS_FAKE_LLM", raising=False)
    monkeypatch.delenv("ABYSS_REAL_MODELS", raising=False)
    return Ledger("j_00000000", tmp_path / "ledger.jsonl")


# ------------------------------------------------------------------ config
def test_dotenv_fills_only_unset_vars(monkeypatch, tmp_path) -> None:
    env = tmp_path / ".env"
    env.write_text('# keys\nABYSS_T_ONE="from-file"\nABYSS_T_TWO=from-file\nABYSS_T_EMPTY=\n', encoding="utf-8")
    monkeypatch.setenv("ABYSS_T_TWO", "from-env")
    monkeypatch.delenv("ABYSS_T_ONE", raising=False)
    monkeypatch.delenv("ABYSS_NO_DOTENV")
    config._load_dotenv(env, tmp_path / "missing.env")
    assert config.os.environ["ABYSS_T_ONE"] == "from-file"
    assert config.os.environ["ABYSS_T_TWO"] == "from-env"
    assert "ABYSS_T_EMPTY" not in config.os.environ
    monkeypatch.delenv("ABYSS_T_ONE")
    monkeypatch.setenv("ABYSS_NO_DOTENV", "1")
    config._load_dotenv(env)
    assert "ABYSS_T_ONE" not in config.os.environ


def test_tiers_test_mode_and_fallback_price(monkeypatch) -> None:
    monkeypatch.delenv("ABYSS_REAL_MODELS", raising=False)
    assert config.served_model("openai", "premium") == "gpt-6-luna"  # test mode: all cheap
    monkeypatch.setenv("ABYSS_REAL_MODELS", "1")
    assert config.served_model("openai", "premium") == "gpt-6-astra"
    assert config.served_model("meta", "budget") == "muse-spark-1.3"
    monkeypatch.setenv("ABYSS_OPENAI_MID", "some-new-model")
    assert config.served_model("openai", "standard") == "some-new-model"
    assert config.PRICES["some-new-model"] == config.FALLBACK_PRICE


def test_available_providers(monkeypatch) -> None:
    monkeypatch.setenv("ABYSS_PROVIDER", "meta")
    monkeypatch.setenv("ABYSS_FAKE_LLM", "1")
    assert config.available_providers() == ["meta"]
    monkeypatch.delenv("ABYSS_FAKE_LLM")
    for key in ("OPENAI_API_KEY", "MODEL_API_KEY", "META_API_KEY", "ANTHROPIC_API_KEY"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("OPENAI_API_KEY", "x")
    monkeypatch.setenv("MODEL_API_KEY", "y")
    assert config.available_providers() == ["meta", "openai"]  # default first


# ----------------------------------------------------------- OpenAI / Meta
async def test_openai_request_usage_and_price(real_calls) -> None:
    completions = FakeCompletions('{"grade": 8}')
    result = await LLM(client=_client(completions), provider="openai").call(
        ledger=real_calls, purpose="review", nominal_model="premium", system="Grade it.",
        user="output", max_tokens=200, effort="low", schema=SCHEMA,
    )
    request = completions.requests[0]
    assert request["model"] == "gpt-6-luna"
    assert request["response_format"] == {"type": "json_object"}
    assert request["reasoning_effort"] == "low" and request["max_completion_tokens"] > 200
    assert "JSON schema" in request["messages"][0]["content"]
    assert result.data == {"grade": 8}
    assert result.usage["input_tokens"] == 1000  # cached tokens counted separately
    expected = (1000 * 0.10 + 300 * 0.50 + 200 * 0.10 * 0.1) / 1_000_000
    assert result.usage["cost_usd"] == pytest.approx(expected, abs=1e-6)


async def test_meta_uses_its_models_and_reasoning_effort(real_calls) -> None:
    completions = FakeCompletions('```json\n{"grade": 7}\n```')
    result = await LLM(client=_client(completions), provider="meta").call(
        ledger=real_calls, purpose="review", nominal_model="standard", system="Grade it.",
        user="output", max_tokens=200, effort="low", schema=SCHEMA,
    )
    request = completions.requests[0]
    assert request["model"] == "muse-spark-1.3"
    assert "response_format" not in request
    assert request["reasoning_effort"] == "low" and request["max_tokens"] > 200
    assert result.data == {"grade": 7}


async def test_refusals_and_bad_json_fail_and_are_ledgered(real_calls) -> None:
    for completions in (FakeCompletions(None, refusal="no"), FakeCompletions("not json")):
        with pytest.raises(LLMError):
            await LLM(client=_client(completions), provider="openai").call(
                ledger=real_calls, purpose="bid", nominal_model="budget", system="s", user="u",
                max_tokens=100, schema=SCHEMA, task_id="t1", agent_id="haiku",
            )
    assert real_calls.total_cost() > 0  # failed calls still cost what they used


# ------------------------------------------------------------- local API
def _server(monkeypatch, tmp_path):
    monkeypatch.setenv("ABYSS_FAKE_LLM", "1")
    monkeypatch.setenv("ABYSS_FAKE_DELAY", "0.01")
    monkeypatch.setenv("ABYSS_LEDGER_PATH", str(tmp_path / "ledger.jsonl"))
    monkeypatch.setenv("ABYSS_REP_PATH", str(tmp_path / "reputation.json"))
    monkeypatch.setenv("ABYSS_SESSIONS_DIR", str(tmp_path / "sessions"))
    import abyss.server

    return importlib.reload(abyss.server)


def test_sessions_and_usage_are_saved(monkeypatch, tmp_path) -> None:
    server = _server(monkeypatch, tmp_path)
    with TestClient(server.app) as client:
        with client.websocket_connect("/ws") as ws:
            ws.receive_json()  # hello
            ws.send_json({"type": "start_job", "job": "Explain tides, then check it."})
            events = []
            while not events or events[-1]["type"] != "final":
                events.append(ws.receive_json())
        final = events[-1]
        listed = client.get("/api/sessions").json()
        assert [s["id"] for s in listed] == [final["job_id"]]
        assert listed[0]["job_text"] == "Explain tides, then check it."
        assert listed[0]["status"] == "ok" and listed[0]["cost_usd"] == pytest.approx(final["data"]["total_cost_usd"])
        full = client.get(f"/api/sessions/{final['job_id']}").json()
        assert full["final"]["deliverable"] == final["data"]["deliverable"]
        assert client.get("/api/sessions/j_nothere").status_code == 404
        assert client.get("/api/sessions/..%2Fsecret").status_code == 404

        usage = client.get("/api/usage").json()
        assert usage["totals"]["jobs"] == 1
        assert usage["totals"]["cost_usd"] == pytest.approx(final["data"]["total_cost_usd"], abs=1e-5)
        assert usage["recent"][0]["premium_equiv_usd"] >= usage["recent"][0]["cost_usd"] - 1e-9

        providers = client.get("/api/providers").json()
        assert [p["id"] for p in providers] == [config.provider()]
        assert "prices" in client.get("/api/prices").json()


def test_start_job_rejects_a_provider_without_a_key(monkeypatch, tmp_path) -> None:
    server = _server(monkeypatch, tmp_path)
    with TestClient(server.app) as client:
        with client.websocket_connect("/ws") as ws:
            ws.receive_json()
            ws.send_json({"type": "start_job", "job": "Say hi.", "provider": "not-an-ai"})
            reply = ws.receive_json()
            assert reply["type"] == "error" and "no API key" in reply["data"]["message"]


def test_the_app_defaults_to_openai_or_muse(monkeypatch) -> None:
    monkeypatch.delenv("ABYSS_PROVIDER")
    for key in ("OPENAI_API_KEY", "MODEL_API_KEY", "META_API_KEY"):
        monkeypatch.delenv(key, raising=False)
    assert config.provider() == "openai"
    monkeypatch.setenv("MODEL_API_KEY", "y")
    assert config.provider() == "meta"  # only a Muse key
    monkeypatch.setenv("OPENAI_API_KEY", "x")
    assert config.provider() == "openai"


def test_the_market_shows_openai_and_muse_models(monkeypatch) -> None:
    from abyss.events import hello_data
    from abyss.reputation import ReputationStore

    monkeypatch.setenv("ABYSS_PROVIDER", "openai")
    hello = hello_data(ReputationStore(None))
    names = {a["agent_id"]: (a["display_name"], a["model"]) for a in hello["agents"]}
    assert names == {
        "haiku": ("GPT-6 Luna", "gpt-6-luna"),
        "sonnet": ("GPT-6 Sol", "gpt-6-sol"),
        "opus": ("GPT-6 Astra", "gpt-6-astra"),
    }
    assert hello["config"]["orchestrator_model"] == "gpt-6-sol"
    assert hello["config"]["prices"]["gpt-6-astra"] == [10.00, 50.00]
    monkeypatch.setenv("ABYSS_PROVIDER", "meta")
    assert {a["model"] for a in hello_data(ReputationStore(None))["agents"]} == {"muse-spark-1.3"}
    assert not any("claude" in str(a) for a in hello_data(ReputationStore(None))["agents"])
