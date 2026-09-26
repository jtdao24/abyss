from __future__ import annotations

from types import SimpleNamespace

import pytest

from abyss import llm as llm_module
from abyss.ledger import Ledger
from abyss.llm import LLM, LLMError


SCHEMA = {
    "type": "object",
    "properties": {"value": {"type": "string"}},
    "required": ["value"],
    "additionalProperties": False,
}


class StubMessages:
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
    def __init__(self, responses: list[object]):
        self.messages = StubMessages(responses)


def response(text: str, *, stop_reason: str = "end_turn") -> SimpleNamespace:
    return SimpleNamespace(
        content=[SimpleNamespace(type="thinking", text="hidden"), SimpleNamespace(type="text", text=text)],
        stop_reason=stop_reason,
        usage=SimpleNamespace(
            input_tokens=12,
            output_tokens=7,
            cache_read_input_tokens=0,
            cache_creation_input_tokens=0,
        ),
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
        nominal_model="claude-sonnet-5",
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
    assert result.usage["model"] == "claude-sonnet-5"
    assert result.usage["output_tokens"] >= 150
    assert len(ledger.entries()) == 1
    assert ledger.entries()[0].purpose == purpose


@pytest.mark.asyncio
async def test_fake_is_deterministic(monkeypatch) -> None:
    monkeypatch.setenv("ABYSS_FAKE_LLM", "1")
    monkeypatch.setenv("ABYSS_FAKE_DELAY", "0")
    kwargs = {
        "purpose": "bid",
        "nominal_model": "claude-haiku-4-5",
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
async def test_real_request_uses_format_without_effort_for_haiku(monkeypatch) -> None:
    monkeypatch.delenv("ABYSS_FAKE_LLM", raising=False)
    client = StubClient([response('{"value":"ok"}')])
    ledger = Ledger("j_00000001", None)

    result = await LLM(client=client).call(
        ledger=ledger,
        purpose="split",
        nominal_model="claude-sonnet-5",
        system="system",
        user="user",
        max_tokens=100,
        effort="low",
        schema=SCHEMA,
    )

    request = client.messages.calls[0]
    assert request["model"] == "claude-haiku-4-5"
    assert request["output_config"] == {
        "format": {"type": "json_schema", "schema": SCHEMA}
    }
    assert "temperature" not in request
    assert "thinking" not in request
    assert result.data == {"value": "ok"}
    assert len(ledger.entries()) == 1


@pytest.mark.asyncio
async def test_haiku_format_400_uses_prompt_fallback(monkeypatch) -> None:
    monkeypatch.delenv("ABYSS_FAKE_LLM", raising=False)
    request = llm_module.anthropic._base_client.httpx2.Request("POST", "https://example.test")
    http_response = llm_module.anthropic._base_client.httpx2.Response(
        400, request=request
    )
    status_error = llm_module.anthropic.APIStatusError(
        "format rejected", response=http_response, body={}
    )
    client = StubClient([status_error, response("Prose ```json\n{\"value\":\"ok\"}\n```")])
    ledger = Ledger("j_00000001", None)

    result = await LLM(client=client).call(
        ledger=ledger,
        purpose="split",
        nominal_model="claude-sonnet-5",
        system="system",
        user="user",
        max_tokens=100,
        schema=SCHEMA,
    )

    assert len(client.messages.calls) == 2
    assert "output_config" not in client.messages.calls[1]
    assert "Respond with only a JSON object" in client.messages.calls[1]["system"]
    assert result.data == {"value": "ok"}
    assert len(ledger.entries()) == 1


@pytest.mark.asyncio
async def test_api_failure_records_once(monkeypatch) -> None:
    monkeypatch.delenv("ABYSS_FAKE_LLM", raising=False)
    error = llm_module.anthropic.APIConnectionError(request=SimpleNamespace())
    ledger = Ledger("j_00000001", None)

    with pytest.raises(LLMError):
        await LLM(client=StubClient([error])).call(
            ledger=ledger,
            purpose="work",
            nominal_model="claude-haiku-4-5",
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
    [(response("anything", stop_reason="refusal"), None), (response("not json"), SCHEMA)],
)
async def test_response_failure_records_once(monkeypatch, reply, schema) -> None:
    monkeypatch.delenv("ABYSS_FAKE_LLM", raising=False)
    ledger = Ledger("j_00000001", None)

    with pytest.raises(LLMError):
        await LLM(client=StubClient([reply])).call(
            ledger=ledger,
            purpose="review",
            nominal_model="claude-haiku-4-5",
            system="system",
            user="user",
            max_tokens=100,
            schema=schema,
            task_id="t1",
        )

    assert len(ledger.entries()) == 1
    assert ledger.entries()[0].ok is False
    assert ledger.entries()[0].input_tokens == 12
