from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

from . import config
from .events import EventStream
from .llm import LLM
from .market import run_job
from .reputation import ReputationStore


async def _run(args: argparse.Namespace) -> int:
    events: list[dict] = []

    async def sink(event: dict) -> None:
        events.append(event)
        if args.jsonl:
            print(json.dumps(event, separators=(",", ":")))
        else:
            print(_event_line(event))

    rep = ReputationStore(config.rep_path())
    stream = EventStream(sink)
    await stream.hello(rep)
    result = await run_job(
        args.job,
        stream=stream,
        llm=LLM(),
        rep=rep,
        price_weight=args.price_weight,
    )

    if args.record is not None:
        args.record.parent.mkdir(parents=True, exist_ok=True)
        args.record.write_text(json.dumps(events, indent=2) + "\n", encoding="utf-8")

    if not args.jsonl:
        print("\nDeliverable:")
        print(result.deliverable or "(none)")
        _print_costs(result.ledger.stats({agent.agent_id: 0 for agent in config.AGENTS}))
    return 0 if result.status != "error" else 1


def _event_line(event: dict) -> str:
    data = event["data"]
    task_id = data.get("task_id")
    prefix = f"[{task_id}] " if task_id else ""
    if event["type"] == "bid" and data["ok"]:
        return (
            f"{prefix}bid {data['agent_id']} q={data['promised_quality']} "
            f"cost=${data['predicted_cost_usd']:.6f} score={data['score']:.3f} "
            f"\"{data['pitch']}\""
        )
    if event["type"] == "won":
        return f"{prefix}won {data['agent_id']} ({data['mode']})"
    if event["type"] == "error":
        return f"{prefix}error: {data['message']}"
    return prefix + event["type"]


def _print_costs(stats: dict) -> None:
    print("\nCosts by purpose:")
    for purpose, values in stats["by_purpose"].items():
        print(f"  {purpose}: ${values['cost_usd']:.6f} ({values['calls']} calls)")
    print("Costs by agent:")
    for agent_id, values in stats["by_agent"].items():
        print(f"  {agent_id}: ${values['cost_usd']:.6f} ({values['calls']} calls)")
    print(f"Total: ${stats['total_cost_usd']:.6f}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run an Abyss job")
    parser.add_argument("job")
    parser.add_argument("--price-weight", type=float, default=config.PRICE_WEIGHT)
    parser.add_argument("--jsonl", action="store_true")
    parser.add_argument("--record", type=Path)
    args = parser.parse_args(argv)
    return asyncio.run(_run(args))


if __name__ == "__main__":
    raise SystemExit(main())
