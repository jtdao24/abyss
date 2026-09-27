from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import logging
import re
import time
from dataclasses import dataclass
from typing import Any, Literal

from . import config, prompts
from .ledger import Ledger, cost_usd
from .tools import CALLER, ToolHub


logger = logging.getLogger(__name__)
Purpose = Literal["split", "bid", "work", "review", "assemble"]
NETWORK_TIMEOUT_SECONDS = 120.0
# Fake mode (tests only): extra "thinking" tokens per tier, like a real run.
THINKING_PAD = {
    "budget": 0,
    "standard": 150,
    "premium": 300,
}


@dataclass
class LLMResult:
    text: str
    data: dict | None
    usage: dict
    stop_reason: str | None


class LLMError(Exception):
    # True once an MCP tool ran: the work may already have posted somewhere,
    # so it must not be retried.
    tools_ran: bool = False


class BudgetExceeded(LLMError):
    """The job's budget can't pay for this call, so it was never made (costs nothing)."""


# Below this many output tokens a call can't produce anything useful.
MIN_BUDGET_TOKENS = 200


def budget_token_cap(ledger: Ledger, model: str, system: str, user: str) -> int | None:
    """The most output tokens this call may use and stay within the job's budget
    (None when there is no budget). Raises BudgetExceeded when nothing's left."""
    remaining = getattr(ledger, "remaining_usd", lambda: None)()
    if remaining is None:
        return None
    input_price, output_price = config.PRICES.get(model, config.FALLBACK_PRICE)
    input_cost = (len(system) + len(user)) / 4 * input_price / 1_000_000
    allowed = int((remaining - input_cost) * 1_000_000 / output_price) if output_price else 10**9
    if remaining <= 0 or allowed < MIN_BUDGET_TOKENS:
        if getattr(ledger, "stopped", False):
            raise BudgetExceeded(f"stopped by you: ${ledger.total_cost():.4f} spent, no new AI calls")
        raise BudgetExceeded(
            f"budget reached: ${ledger.total_cost():.4f} of ${ledger.budget_usd:.4f} spent"
        )
    return allowed


def _apply_cap(request: dict, cap: int | None) -> None:
    if cap is None:
        return
    for key in ("max_completion_tokens", "max_tokens"):
        if key in request:
            request[key] = min(request[key], cap)


class LLM:
    def __init__(
        self, client: Any | None = None, provider: str | None = None, tools: ToolHub | None = None
    ) -> None:
        self._fake = config.fake_llm()
        self._client = client
        self._provider = provider  # None follows ABYSS_PROVIDER
        # MCP tools (mcp.json) for work calls; fake mode never touches the network.
        self._tools = tools if tools is not None or self._fake else _load_tools()

    @property
    def provider_name(self) -> str:
        """The AI this LLM calls."""
        return self._provider or config.provider()

    async def call(
        self,
        *,
        ledger: Ledger,
        purpose: Purpose,
        nominal_model: str,
        system: str,
        user: str,
        max_tokens: int,
        effort: str | None = None,
        schema: dict | None = None,
        task_id: str | None = None,
        agent_id: str | None = None,
    ) -> LLMResult:
        if self._fake:
            return await self._fake_call(
                ledger=ledger,
                purpose=purpose,
                nominal_model=nominal_model,
                system=system,
                user=user,
                schema=schema,
                task_id=task_id,
                agent_id=agent_id,
            )

        provider_name = self.provider_name
        served = config.served_model(provider_name, nominal_model)
        if purpose == "work" and _takes_tools(provider_name, served) and await self._tools_ready():
            return await self._openai_tool_work(
                provider_name=provider_name,
                ledger=ledger,
                nominal_model=nominal_model,
                system=system + prompts.WORK_TOOLS,
                user=user,
                max_tokens=max_tokens,
                effort=effort,
                task_id=task_id,
                agent_id=agent_id,
            )
        return await self._openai_call(
            provider_name=provider_name,
            ledger=ledger,
            purpose=purpose,
            nominal_model=nominal_model,
            system=system,
            user=user,
            max_tokens=max_tokens,
            effort=effort,
            schema=schema,
            task_id=task_id,
            agent_id=agent_id,
        )

    # ------------------------------------------------------------ MCP tool work
    async def _tools_ready(self) -> bool:
        if self._tools is None:
            return False
        await self._tools.start()
        return bool(self._tools.definitions())

    async def _run_tools(
        self, calls: list[tuple[str, str, dict]], caller: tuple[str | None, str | None] = (None, None)
    ) -> list[tuple[str, str, bool]]:
        """(id, name, arguments) -> (id, text, is_error), run concurrently."""
        async def one(call_id: str, name: str, arguments: dict) -> tuple[str, str, bool]:
            CALLER.set(caller)
            logger.info("tool %s %s", name, json.dumps(arguments)[:200])
            text, is_error = await self._tools.call(name, arguments)
            return call_id, text, is_error

        return list(await asyncio.gather(*(one(*call) for call in calls)))

    async def _openai_tool_work(
        self,
        *,
        provider_name: str,
        ledger: Ledger,
        nominal_model: str,
        system: str,
        user: str,
        max_tokens: int,
        effort: str | None,
        task_id: str | None,
        agent_id: str | None,
    ) -> LLMResult:
        import openai

        model = config.served_model(provider_name, nominal_model)
        if self._client is None:
            if provider_name == "meta":
                self._client = openai.AsyncOpenAI(
                    base_url=config.META_BASE_URL, api_key=config.meta_api_key(), timeout=NETWORK_TIMEOUT_SECONDS
                )
            else:
                self._client = openai.AsyncOpenAI(timeout=NETWORK_TIMEOUT_SECONDS)
        request = _openai_request(
            provider_name=provider_name, model=model, system=system, user=user,
            max_tokens=max_tokens, effort=effort, schema=None,
        )
        if provider_name != "meta" and "reasoning_effort" in request:
            # OpenAI's Chat Completions takes function tools only with reasoning off.
            request["reasoning_effort"] = "none"
        request["tools"] = [
            {"type": "function", "function": {
                "name": tool["name"], "description": tool["description"], "parameters": tool["input_schema"],
            }}
            for tool in self._tools.definitions()
        ]
        messages = request["messages"]
        rounds: list[LLMResult] = []
        tools_ran = False
        for round_no in range(config.MAX_TOOL_ROUNDS + 1):
            if round_no == config.MAX_TOOL_ROUNDS:
                request["tool_choice"] = "none"
            try:
                cap = budget_token_cap(ledger, model, system, json.dumps(messages, default=str))
            except BudgetExceeded as exc:
                exc.tools_ran = tools_ran
                raise
            _apply_cap(request, cap)
            started = time.monotonic()
            try:
                response = await asyncio.wait_for(
                    self._client.chat.completions.create(**request), timeout=NETWORK_TIMEOUT_SECONDS
                )
            except (openai.APIStatusError, openai.APIConnectionError, asyncio.TimeoutError) as exc:
                self._record_error(ledger, "work", model, task_id, agent_id, started, str(exc))
                raise _tool_error(str(exc), tools_ran) from exc
            choice = response.choices[0]
            message = choice.message
            stop_reason = OPENAI_STOP_REASONS.get(choice.finish_reason, choice.finish_reason)
            usage_values = _openai_usage_values(response)
            duration_ms = _duration_ms(started)
            price = cost_usd(
                model, usage_values["input_tokens"], usage_values["output_tokens"], usage_values["cache_read_input_tokens"]
            )
            calls = list(getattr(message, "tool_calls", None) or [])
            refused = getattr(message, "refusal", None) or choice.finish_reason == "content_filter"
            error = "model refused the request" if refused else None
            if error is None and not calls and not (message.content or "").strip():
                error = f"empty response (finish_reason={choice.finish_reason})"
            self._record(ledger, "work", model, task_id, agent_id, usage_values, price, duration_ms,
                         error is None, stop_reason, error)
            if error is not None:
                raise _tool_error(error, tools_ran)
            rounds.append(LLMResult(
                text=message.content or "", data=None, stop_reason=stop_reason,
                usage={"model": model, "input_tokens": usage_values["input_tokens"],
                       "output_tokens": usage_values["output_tokens"], "cost_usd": price,
                       "duration_ms": duration_ms},
            ))
            if not calls:
                break
            tools_ran = True
            parsed = [(call.id, call.function.name, _json_args(call.function.arguments)) for call in calls]
            results = await self._run_tools(parsed, (agent_id, task_id))
            messages.append({
                "role": "assistant",
                "content": message.content,
                "tool_calls": [
                    {"id": call.id, "type": "function",
                     "function": {"name": call.function.name, "arguments": call.function.arguments}}
                    for call in calls
                ],
            })
            messages.extend(
                {"role": "tool", "tool_call_id": call_id, "content": ("ERROR: " if is_error else "") + text}
                for call_id, text, is_error in results
            )
        return _merge_rounds(rounds)

    # ------------------------------------------- OpenAI-compatible (OpenAI, Meta)
    async def _openai_call(
        self,
        *,
        provider_name: str,
        ledger: Ledger,
        purpose: Purpose,
        nominal_model: str,
        system: str,
        user: str,
        max_tokens: int,
        effort: str | None,
        schema: dict | None,
        task_id: str | None,
        agent_id: str | None,
    ) -> LLMResult:
        import openai  # only needed for these providers

        model = config.served_model(provider_name, nominal_model)
        started = time.monotonic()
        if self._client is None:
            if provider_name == "meta":
                self._client = openai.AsyncOpenAI(
                    base_url=config.META_BASE_URL, api_key=config.meta_api_key(), timeout=NETWORK_TIMEOUT_SECONDS
                )
            else:
                self._client = openai.AsyncOpenAI(timeout=NETWORK_TIMEOUT_SECONDS)
        request = _openai_request(
            provider_name=provider_name, model=model, system=system, user=user,
            max_tokens=max_tokens, effort=effort, schema=schema,
        )
        _apply_cap(request, budget_token_cap(ledger, model, system, user))
        try:
            response = await asyncio.wait_for(
                self._client.chat.completions.create(**request), timeout=NETWORK_TIMEOUT_SECONDS
            )
        except (openai.APIStatusError, openai.APIConnectionError, asyncio.TimeoutError) as exc:
            self._record_error(ledger, purpose, model, task_id, agent_id, started, str(exc))
            raise LLMError(str(exc)) from exc

        choice = response.choices[0]
        message = choice.message
        text = message.content or ""
        stop_reason = OPENAI_STOP_REASONS.get(choice.finish_reason, choice.finish_reason)
        usage_values = _openai_usage_values(response)
        duration_ms = _duration_ms(started)
        price = cost_usd(
            model, usage_values["input_tokens"], usage_values["output_tokens"], usage_values["cache_read_input_tokens"]
        )

        def fail(error: str) -> LLMError:
            self._record(ledger, purpose, model, task_id, agent_id, usage_values, price, duration_ms, False, stop_reason, error)
            return LLMError(error)

        if getattr(message, "refusal", None) or choice.finish_reason == "content_filter":
            raise fail("model refused the request")
        if not text.strip():
            raise fail(f"empty response (finish_reason={choice.finish_reason})")
        data: dict | None = None
        if schema is not None:
            try:
                data = _parse_json_object(text)
            except (json.JSONDecodeError, ValueError) as exc:
                raise fail(f"invalid JSON response: {exc}") from exc

        self._record(ledger, purpose, model, task_id, agent_id, usage_values, price, duration_ms, True, stop_reason, None)
        usage = {
            "model": model,
            "input_tokens": usage_values["input_tokens"],
            "output_tokens": usage_values["output_tokens"],
            "cost_usd": price,
            "duration_ms": duration_ms,
        }
        return LLMResult(text=text, data=data, usage=usage, stop_reason=stop_reason)

    async def _fake_call(
        self,
        *,
        ledger: Ledger,
        purpose: Purpose,
        nominal_model: str,
        system: str,
        user: str,
        schema: dict | None,
        task_id: str | None,
        agent_id: str | None,
    ) -> LLMResult:
        started = time.monotonic()
        await asyncio.sleep(config.fake_delay())
        digest = hashlib.sha256(
            (purpose + nominal_model + user).encode("utf-8")
        ).digest()
        text, data = _fake_output(purpose, user, digest)
        if schema is None:
            data = None
        input_tokens = len(system + user) // 4
        output_tokens = len(text) // 4 + THINKING_PAD.get(nominal_model, 0)
        # Name and price fake calls as the provider's model for this tier, so
        # fake mode's ledger and costs look like a real OpenAI / Muse run.
        model = config.tier_model(nominal_model, self.provider_name)
        cap = budget_token_cap(ledger, model, system, user)
        if cap is not None:
            output_tokens = min(output_tokens, cap)
        price = cost_usd(model, input_tokens, output_tokens)
        duration_ms = _duration_ms(started)
        usage_values = {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 0,
        }
        self._record(
            ledger,
            purpose,
            model,
            task_id,
            agent_id,
            usage_values,
            price,
            duration_ms,
            True,
            "end_turn",
            None,
        )
        usage = {
            "model": model,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cost_usd": price,
            "duration_ms": duration_ms,
        }
        return LLMResult(text=text, data=data, usage=usage, stop_reason="end_turn")

    @staticmethod
    def _record(
        ledger: Ledger,
        purpose: Purpose,
        model: str,
        task_id: str | None,
        agent_id: str | None,
        usage: dict[str, int],
        price: float,
        duration_ms: int,
        ok: bool,
        stop_reason: str | None,
        error: str | None,
    ) -> None:
        ledger.record(
            task_id=task_id,
            agent_id=agent_id if purpose in {"bid", "work"} else None,
            purpose=purpose,
            model=model,
            input_tokens=usage["input_tokens"],
            output_tokens=usage["output_tokens"],
            cache_read_input_tokens=usage["cache_read_input_tokens"],
            cache_creation_input_tokens=usage["cache_creation_input_tokens"],
            cost_usd=price,
            ok=ok,
            stop_reason=stop_reason,
            error=error,
            duration_ms=duration_ms,
        )

    def _record_error(
        self,
        ledger: Ledger,
        purpose: Purpose,
        model: str,
        task_id: str | None,
        agent_id: str | None,
        started: float,
        error: str,
    ) -> None:
        self._record(
            ledger,
            purpose,
            model,
            task_id,
            agent_id,
            {
                "input_tokens": 0,
                "output_tokens": 0,
                "cache_read_input_tokens": 0,
                "cache_creation_input_tokens": 0,
            },
            0.0,
            _duration_ms(started),
            False,
            None,
            error,
        )


def _load_tools():
    """The process-wide MCP servers (mcp.json), shared by every LLM."""
    from .tools import shared

    return shared()


def _tool_error(message: str, tools_ran: bool) -> LLMError:
    error = LLMError(message)
    error.tools_ran = tools_ran
    return error


def _json_args(raw: str | None) -> dict:
    try:
        parsed = json.loads(raw or "{}")
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _merge_rounds(rounds: list[LLMResult]) -> LLMResult:
    """One work result from several tool round trips: the last answer, summed usage."""
    last = rounds[-1]
    usage = dict(last.usage)
    for key in ("input_tokens", "output_tokens", "duration_ms"):
        usage[key] = sum(r.usage[key] for r in rounds)
    usage["cost_usd"] = round(sum(r.usage["cost_usd"] for r in rounds), 6)
    return LLMResult(text=last.text, data=None, usage=usage, stop_reason=last.stop_reason)


def _duration_ms(started: float) -> int:
    return round((time.monotonic() - started) * 1000)


OPENAI_STOP_REASONS = {"stop": "end_turn", "length": "max_tokens", "content_filter": "refusal"}
# Reasoning models spend hidden tokens before answering, and those count against
# the completion cap: give it headroom (only tokens actually used are billed).
REASONING_HEADROOM = 4000


# OpenAI models that can't turn reasoning off, so can't use function tools on
# Chat Completions at all: they do their work without tools.
NO_TOOL_MODELS = {"gpt-6-astra"}


def _takes_tools(provider_name: str, model: str) -> bool:
    return provider_name == "meta" or model not in NO_TOOL_MODELS


def _openai_request(
    *,
    provider_name: str,
    model: str,
    system: str,
    user: str,
    max_tokens: int,
    effort: str | None,
    schema: dict | None,
) -> dict[str, Any]:
    if schema is not None:
        system += "\n\nRespond with only a JSON object matching this JSON schema: " + json.dumps(
            schema, separators=(",", ":")
        )
    request: dict[str, Any] = {
        "model": model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
    }
    if provider_name == "meta":
        # Muse Spark reasons first; unset, a tiny call reasoned ~2,600 tokens.
        request["max_tokens"] = max_tokens + REASONING_HEADROOM
        request["reasoning_effort"] = effort if effort in {"minimal", "low", "medium", "high"} else "low"
        return request
    if model.startswith(("gpt-6", "gpt-5", "o1", "o3", "o4")):
        request["max_completion_tokens"] = max_tokens + REASONING_HEADROOM
        request["reasoning_effort"] = effort if effort in {"low", "medium", "high"} else "low"
    else:
        request["max_tokens"] = max_tokens
    if schema is not None:
        request["response_format"] = {"type": "json_object"}
    return request


def _openai_usage_values(response: Any) -> dict[str, int]:
    usage = response.usage
    details = getattr(usage, "prompt_tokens_details", None)
    cached = (getattr(details, "cached_tokens", 0) or 0) if details is not None else 0
    return {
        # input_tokens excludes cache reads (those are billed at a discount).
        "input_tokens": max(0, usage.prompt_tokens - cached),
        "output_tokens": usage.completion_tokens,
        "cache_read_input_tokens": cached,
        "cache_creation_input_tokens": 0,
    }


def _parse_json_object(text: str) -> dict:
    stripped = text.strip()
    fenced = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", stripped, re.DOTALL)
    if fenced:
        stripped = fenced.group(1)
    try:
        parsed = json.loads(stripped)
    except json.JSONDecodeError:
        start = stripped.find("{")
        end = stripped.rfind("}")
        if start < 0 or end < start:
            raise
        parsed = json.loads(stripped[start : end + 1])
    if not isinstance(parsed, dict):
        raise ValueError("response JSON must be an object")
    return parsed


def _fake_output(purpose: Purpose, user: str, digest: bytes) -> tuple[str, dict | None]:
    if purpose == "split":
        data = {
            "tasks": [
                {
                    "type": "research",
                    "title": "Research the key facts",
                    "brief": "Find the accurate facts and caveats needed for the requested answer.",
                    "depends_on": [],
                },
                {
                    "type": "writing",
                    "title": "Write the requested response",
                    "brief": "Use the research to produce the requested clear final response.",
                    "depends_on": [0],
                },
                {
                    "type": "checking",
                    "title": "Fact-check the response",
                    "brief": "Check the written response and identify any factual errors or caveats.",
                    "depends_on": [1],
                },
            ]
        }
        return json.dumps(data), data
    if purpose == "bid":
        data = {
            "predicted_output_tokens": 150 + int.from_bytes(digest[:2], "big") % 551,
            "promised_quality": 6 + digest[2] % 5,
            "pitch": "A careful, concise result at a competitive price.",
        }
        return json.dumps(data), data
    if purpose == "assemble":
        code = any(word in user.lower() for word in ("python", "code", "function", "script", "program"))
        body = user.split("Task outputs:", 1)[-1].strip()
        data = {
            "filename": "solution.py" if code else "result.md",
            "content": ("# Assembled by the main agent (fake mode)\n" if code else "# Result (fake mode)\n\n") + body,
            "summary": "Combined the vendors' work into one file and applied the checker's notes.",
        }
        return json.dumps(data), data
    if purpose == "review":
        data = {
            "grade": 5 + digest[0] % 6,
            "rationale": "The response is relevant, clear, and mostly accurate.",
        }
        return json.dumps(data), data

    brief = user
    marker = "Task brief:\n"
    if marker in user:
        brief = user.split(marker, 1)[1].splitlines()[0]
    first_words = " ".join(brief.split()[:8])
    text = (
        f"Completed work for: {first_words}. "
        "The response is concise, useful, and follows the requested task constraints."
    )
    return text, None


async def _smoke() -> int:
    ledger = Ledger("j_00000000", config.ledger_path())
    llm = LLM()
    object_schema = {
        "type": "object",
        "properties": {"answer": {"type": "string"}},
        "required": ["answer"],
        "additionalProperties": False,
    }
    calls = [
        ("split", None, None, object_schema),
        ("bid", "t1", "haiku", object_schema),
        ("work", "t1", "haiku", None),
        ("review", "t1", None, object_schema),
    ]
    for purpose, task_id, agent_id, schema in calls:
        result = await llm.call(
            ledger=ledger,
            purpose=purpose,
            nominal_model="budget",
            system="Answer briefly.",
            user="Return a tiny answer.",
            max_tokens=128,
            effort="low",
            schema=schema,
            task_id=task_id,
            agent_id=agent_id,
        )
        print(result.usage)
    print({"total_cost_usd": ledger.total_cost()})
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Abyss LLM gateway")
    parser.add_argument("--smoke", action="store_true")
    args = parser.parse_args(argv)
    if not args.smoke:
        parser.error("--smoke is required")
    return asyncio.run(_smoke())


if __name__ == "__main__":
    raise SystemExit(main())
