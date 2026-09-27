from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from abyss import config, prompts
from abyss.ledger import Ledger
from abyss.llm import LLM, LLMError
from abyss.market import _work_with_retry
from abyss.orchestrator import TaskSpec
from abyss.tools import ToolHub, load_servers, tool_name


class StubHub:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []

    async def start(self) -> None:
        pass

    def definitions(self) -> list[dict]:
        return [{"name": "slack__post", "description": "Post a message", "input_schema": {"type": "object"}}]

    async def call(self, name: str, arguments: dict) -> tuple[str, bool]:
        self.calls.append((name, arguments))
        return "posted", False


class StubCompletions:
    """Looks like openai.AsyncOpenAI().chat.completions (OpenAI and Meta Muse)."""

    def __init__(self, responses: list[object]):
        self.responses = list(responses)
        self.calls: list[dict] = []

    async def create(self, **kwargs):
        self.calls.append({**kwargs, "messages": list(kwargs["messages"])})
        response = self.responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        return response


def completion(message: SimpleNamespace, finish_reason: str, prompt: int, completion_tokens: int) -> SimpleNamespace:
    return SimpleNamespace(
        choices=[SimpleNamespace(message=message, finish_reason=finish_reason)],
        usage=SimpleNamespace(prompt_tokens=prompt, completion_tokens=completion_tokens, prompt_tokens_details=None),
    )


def tool_use_response() -> SimpleNamespace:
    call = SimpleNamespace(id="c1", function=SimpleNamespace(name="slack__post", arguments='{"text": "hi"}'))
    return completion(SimpleNamespace(content="Posting.", tool_calls=[call], refusal=None), "tool_calls", 100, 20)


def final_response(text: str = "Posted the summary to Slack.") -> SimpleNamespace:
    return completion(SimpleNamespace(content=text, tool_calls=None, refusal=None), "stop", 150, 10)


def openai_llm(responses: list[object], hub: StubHub) -> tuple[LLM, StubCompletions]:
    completions = StubCompletions(responses)
    llm = LLM(client=SimpleNamespace(chat=SimpleNamespace(completions=completions)), provider="openai", tools=hub)
    return llm, completions


async def work(llm: LLM, ledger: Ledger, purpose: str = "work"):
    return await llm.call(
        ledger=ledger, purpose=purpose, nominal_model="budget",
        system="Do the task.", user="Summarize and post to #general.", max_tokens=500,
        task_id="t1", agent_id="haiku",
    )


@pytest.mark.asyncio
async def test_work_runs_tools_and_bills_every_round() -> None:
    hub = StubHub()
    llm, completions = openai_llm([tool_use_response(), final_response()], hub)
    ledger = Ledger("j_00000001", None)

    result = await work(llm, ledger)

    assert result.text == "Posted the summary to Slack."
    assert hub.calls == [("slack__post", {"text": "hi"})]
    assert result.usage["input_tokens"] == 250 and result.usage["output_tokens"] == 30
    assert [e.purpose for e in ledger.entries()] == ["work", "work"]
    assert result.usage["cost_usd"] == pytest.approx(ledger.total_cost())
    first, second = completions.calls
    assert [t["function"]["name"] for t in first["tools"]] == ["slack__post"]
    assert first["messages"][0]["content"].endswith(prompts.WORK_TOOLS)
    assert second["messages"][-1] == {"role": "tool", "tool_call_id": "c1", "content": "posted"}


@pytest.mark.asyncio
async def test_openai_tool_work_turns_reasoning_off() -> None:
    # OpenAI rejects function tools with reasoning_effort on Chat Completions.
    llm, completions = openai_llm([final_response()], StubHub())
    await work(llm, Ledger("j_00000001", None))
    assert completions.calls[0]["reasoning_effort"] == "none"


@pytest.mark.asyncio
async def test_models_that_cant_turn_reasoning_off_work_without_tools(monkeypatch) -> None:
    monkeypatch.setattr(config, "served_model", lambda provider, nominal: "gpt-6-astra")
    hub = StubHub()
    llm, completions = openai_llm([final_response("Done without tools.")], hub)
    result = await work(llm, Ledger("j_00000001", None))
    assert result.text == "Done without tools."
    assert "tools" not in completions.calls[0]
    assert completions.calls[0]["reasoning_effort"] == "low"


@pytest.mark.asyncio
async def test_other_purposes_never_see_tools() -> None:
    llm, completions = openai_llm([final_response()], StubHub())
    await work(llm, Ledger("j_00000001", None), purpose="review")
    assert "tools" not in completions.calls[0]


@pytest.mark.asyncio
async def test_out_of_rounds_forces_an_answer(monkeypatch) -> None:
    monkeypatch.setattr(config, "MAX_TOOL_ROUNDS", 1)
    llm, completions = openai_llm([tool_use_response(), final_response()], StubHub())
    await work(llm, Ledger("j_00000001", None))
    assert "tool_choice" not in completions.calls[0]
    assert completions.calls[1]["tool_choice"] == "none"


@pytest.mark.asyncio
async def test_failure_after_a_tool_ran_is_not_retried() -> None:
    import openai

    hub = StubHub()
    failure = openai.APIConnectionError(request=SimpleNamespace(method="POST", url="x"))
    llm, completions = openai_llm([tool_use_response(), failure, final_response()], hub)
    agent = config.AGENTS[0]
    task = TaskSpec(task_id="t1", type="writing", title="Post", brief="Post it.", depends_on=[])

    with pytest.raises(LLMError) as caught:
        await _work_with_retry(llm, Ledger("j_00000001", None), agent, "job", task, {}, [])

    assert caught.value.tools_ran
    assert len(completions.calls) == 2  # no second attempt, so no second post
    assert len(hub.calls) == 1


@pytest.mark.asyncio
async def test_openai_providers_use_function_tools() -> None:
    def completion(message, finish_reason):
        return SimpleNamespace(
            choices=[SimpleNamespace(message=message, finish_reason=finish_reason)],
            usage=SimpleNamespace(prompt_tokens=80, completion_tokens=12, prompt_tokens_details=None),
        )

    call = SimpleNamespace(id="c1", function=SimpleNamespace(name="slack__post", arguments='{"text": "hi"}'))
    responses = [
        completion(SimpleNamespace(content=None, tool_calls=[call], refusal=None), "tool_calls"),
        completion(SimpleNamespace(content="Done.", tool_calls=None, refusal=None), "stop"),
    ]
    sent: list[dict] = []

    async def create(**kwargs):
        sent.append({**kwargs, "messages": list(kwargs["messages"])})
        return responses.pop(0)

    hub = StubHub()
    client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    llm = LLM(client=client, provider="openai", tools=hub)
    ledger = Ledger("j_00000001", None)

    result = await work(llm, ledger)

    assert result.text == "Done."
    assert hub.calls == [("slack__post", {"text": "hi"})]
    assert sent[0]["tools"][0]["function"]["name"] == "slack__post"
    assert sent[1]["messages"][-1] == {"role": "tool", "tool_call_id": "c1", "content": "posted"}
    assert len(ledger.entries()) == 2


def test_config_fills_env_vars_and_skips_disabled(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("NOTION_TOKEN", "secret-token")
    path = tmp_path / "mcp.json"
    path.write_text(json.dumps({"mcpServers": {
        "notion": {"command": "npx", "env": {"NOTION_TOKEN": "${NOTION_TOKEN}"}},
        "slack": {"command": "npx", "disabled": True},
    }}), encoding="utf-8")

    servers = load_servers(path)

    assert servers == {"notion": {"command": "npx", "env": {"NOTION_TOKEN": "secret-token"}}}
    assert load_servers(tmp_path / "missing.json") == {}
    assert tool_name("my server", "post.message") == "my_server__post_message"


@pytest.mark.asyncio
async def test_hub_talks_to_a_real_stdio_server() -> None:
    hub = ToolHub({"echo": {
        "command": sys.executable,
        "args": [str(Path(__file__).parent / "echo_mcp_server.py")],
        "allow": ["shout"],
    }})
    try:
        await hub.start()
        assert [tool["name"] for tool in hub.definitions()] == ["echo__shout"]
        assert await hub.call("echo__shout", {"text": "ahoy"}) == ("AHOY", False)
        text, is_error = await hub.call("echo__secret", {})
        assert is_error
    finally:
        await hub.close()
