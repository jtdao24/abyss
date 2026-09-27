from __future__ import annotations

from types import SimpleNamespace

import openai
import pytest

from abyss.ledger import Ledger
from abyss.llm import LLM, LLMError


SCHEMA = {
    "type": "object",
    "properties": {"value": {"type": "string"}},
    "required": ["value"],
    "additionalProperties": False,
}


class StubCompletions:
    def __init__(self, responses: list[object]):
        self.responses = list(responses)
        self.calls: list[dict] = []

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        response = self.responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        return response


class StubClient:
    """Looks like openai.AsyncOpenAI (chat.completions.create) for OpenAI and Meta."""

    def __init__(self, responses: list[object]):
        self.completions = StubCompletions(responses)
        self.chat = SimpleNamespace(completions=self.completions)


def response(text: str | None, *, finish_reason: str = "stop", refusal: str | None = None) -> SimpleNamespace:
    return SimpleNamespace(
        choices=[SimpleNamespace(
            message=SimpleNamespace(content=text, refusal=refusal, tool_calls=None),
            finish_reason=finish_reason,
        )],
        usage=SimpleNamespace(prompt_tokens=12, completion_tokens=7, prompt_tokens_details=None),
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("purpose", ["split", "bid", "work", "review"])
async def test_fake_shapes_and_ledger(monkeypatch, purpose: str) -> None:
    monkeypatch.setenv("ABYSS_FAKE_LLM", "1")
    monkeypatch.setenv("ABYSS_FAKE_DELAY", "0")
    ledger = Ledger("j_00000001", None)
    schema = None if purpose == "work" else SCHEMA

    result = await LLM().call(
        ledger=ledger,
        purpose=purpose,
        nominal_model="standard",
        system="system",
        user="Task brief:\nExplain a useful fact clearly and briefly.",
        max_tokens=100,
        effort="low",
        schema=schema,
        task_id=None if purpose == "split" else "t1",
        agent_id="sonnet" if purpose in {"bid", "work"} else None,
    )

    assert isinstance(result.text, str)
    assert (result.data is None) == (purpose == "work")
    assert result.usage["model"] == "gpt-5"  # the standard tier on OpenAI
    assert result.usage["output_tokens"] >= 150
    assert len(ledger.entries()) == 1
    assert ledger.entries()[0].purpose == purpose


@pytest.mark.asyncio
async def test_fake_is_deterministic(monkeypatch) -> None:
    monkeypatch.setenv("ABYSS_FAKE_LLM", "1")
    monkeypatch.setenv("ABYSS_FAKE_DELAY", "0")
    kwargs = {
        "purpose": "bid",
        "nominal_model": "budget",
        "system": "same system",
        "user": "same user",
        "max_tokens": 100,
        "schema": SCHEMA,
        "task_id": "t1",
        "agent_id": "haiku",
    }
    first = await LLM().call(ledger=Ledger("j_00000001", None), **kwargs)
    second = await LLM().call(ledger=Ledger("j_00000002", None), **kwargs)

    assert first.text == second.text
    assert first.data == second.data
    assert first.usage["input_tokens"] == second.usage["input_tokens"]
    assert first.usage["output_tokens"] == second.usage["output_tokens"]


@pytest.mark.asyncio
async def test_real_request_in_test_mode_uses_the_budget_model(monkeypatch) -> None:
    monkeypatch.delenv("ABYSS_FAKE_LLM", raising=False)
    client = StubClient([response('{"value":"ok"}')])
    ledger = Ledger("j_00000001", None)

    result = await LLM(client=client).call(
        ledger=ledger,
        purpose="split",
        nominal_model="standard",
        system="system",
        user="user",
        max_tokens=100,
        effort="low",
        schema=SCHEMA,
    )

    request = client.completions.calls[0]
    assert request["model"] == "gpt-5-mini"  # conftest runs in test mode
    assert request["response_format"] == {"type": "json_object"}
    assert request["reasoning_effort"] == "low"
    assert "Respond with only a JSON object" in request["messages"][0]["content"]
    assert result.data == {"value": "ok"}
    assert len(ledger.entries()) == 1


@pytest.mark.asyncio
async def test_real_models_use_each_tiers_model(monkeypatch) -> None:
    monkeypatch.delenv("ABYSS_FAKE_LLM", raising=False)
    monkeypatch.setenv("ABYSS_REAL_MODELS", "1")
    client = StubClient([response("done"), response("done")])
    for tier in ("premium", "budget"):
        await LLM(client=client).call(
            ledger=Ledger("j_00000001", None), purpose="work", nominal_model=tier,
            system="s", user="u", max_tokens=100, task_id="t1", agent_id="opus",
        )
    assert [c["model"] for c in client.completions.calls] == ["gpt-5", "gpt-5-mini"]


@pytest.mark.asyncio
async def test_api_failure_records_once(monkeypatch) -> None:
    monkeypatch.delenv("ABYSS_FAKE_LLM", raising=False)
    error = openai.APIConnectionError(request=SimpleNamespace(method="POST", url="https://example.test"))
    ledger = Ledger("j_00000001", None)

    with pytest.raises(LLMError):
        await LLM(client=StubClient([error])).call(
            ledger=ledger,
            purpose="work",
            nominal_model="budget",
            system="system",
            user="user",
            max_tokens=100,
            task_id="t1",
            agent_id="haiku",
        )

    assert len(ledger.entries()) == 1
    assert ledger.entries()[0].ok is False
    assert ledger.entries()[0].input_tokens == 0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("reply", "schema"),
    [(response(None, refusal="no"), None), (response("not json"), SCHEMA), (response("", finish_reason="length"), None)],
)
async def test_response_failure_records_once(monkeypatch, reply, schema) -> None:
    monkeypatch.delenv("ABYSS_FAKE_LLM", raising=False)
    ledger = Ledger("j_00000001", None)

    with pytest.raises(LLMError):
        await LLM(client=StubClient([reply])).call(
            ledger=ledger,
            purpose="review",
            nominal_model="budget",
            system="system",
            user="user",
            max_tokens=100,
            schema=schema,
            task_id="t1",
        )

    assert len(ledger.entries()) == 1
    assert ledger.entries()[0].ok is False
    assert ledger.entries()[0].input_tokens == 12
