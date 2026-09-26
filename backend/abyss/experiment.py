"""Cost/quality experiment: market arms vs fixed-agent arms on the same jobs.

Every job is split once (cached in experiments/splits/) so every arm works on
identical tasks. Each arm runs all jobs sequentially from a fresh in-memory
ReputationStore, so market arms show a learning curve across jobs.

    python -m abyss.experiment --estimate
    python -m abyss.experiment --arms market@1,fixed:opus
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

from . import config
from .events import EventStream
from .ledger import Ledger, cost_usd
from .llm import LLM
from .market import run_job
from .orchestrator import TaskSpec, split_job
from .reputation import ReputationStore


EXPERIMENTS_DIR = config.REPO_ROOT / "experiments"
DEFAULT_ARMS = "market@0,market@1,market@3,fixed:haiku,fixed:sonnet,fixed:opus"
ASSUMED_TASKS_PER_JOB = 3
# --estimate token assumptions (per call)
EST_WORK = (1000, 1500)
EST_SMALL = (600, 300)  # bid, review, split


@dataclass(frozen=True)
class Arm:
    name: str
    price_weight: float
    fixed_agent_id: str | None


def parse_arms(spec: str) -> list[Arm]:
    if spec == "all":
        spec = DEFAULT_ARMS
    agent_ids = {agent.agent_id for agent in config.AGENTS}
    arms: list[Arm] = []
    for name in (part.strip() for part in spec.split(",") if part.strip()):
        if name.startswith("market@"):
            arms.append(Arm(name, float(name.removeprefix("market@")), None))
        elif name.startswith("fixed:") and name.removeprefix("fixed:") in agent_ids:
            arms.append(Arm(name, config.PRICE_WEIGHT, name.removeprefix("fixed:")))
        else:
            raise ValueError(f"unknown arm {name!r}")
    return arms


def load_jobs(path: Path) -> list[dict]:
    jobs = json.loads(path.read_text(encoding="utf-8"))
    for job in jobs:
        if not isinstance(job.get("id"), str) or not isinstance(job.get("job"), str):
            raise ValueError("each job needs string 'id' and 'job' fields")
    return jobs


def _split_path(splits_dir: Path, job_text: str) -> Path:
    return splits_dir / f"{hashlib.sha1(job_text.encode('utf-8')).hexdigest()}.json"


async def get_split(
    llm: LLM, job_text: str, splits_dir: Path
) -> tuple[list[TaskSpec], float, int]:
    """Return (tasks, split_cost_usd, split_calls). A cache hit costs nothing."""
    path = _split_path(splits_dir, job_text)
    if path.exists():
        cached = json.loads(path.read_text(encoding="utf-8"))
        return [TaskSpec(**task) for task in cached["tasks"]], 0.0, 0
    ledger = Ledger("j_split000", config.ledger_path())
    tasks, _ = await split_job(llm, ledger, job_text)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"job": job_text, "tasks": [asdict(t) for t in tasks]}, indent=2) + "\n",
        encoding="utf-8",
    )
    return tasks, ledger.total_cost(), len(ledger.entries())


async def run_arm(
    arm: Arm, jobs: list[dict], splits: list[list[TaskSpec]], llm: LLM
) -> dict:
    rep = ReputationStore()  # fresh and in-memory: no persistence
    by_purpose = {purpose: 0.0 for purpose in ("bid", "work", "review")}
    wins = {a.agent_id: {t: 0 for t in config.TASK_TYPES} for a in config.AGENTS}
    grades: list[int] = []
    failed_tasks = 0
    per_job: list[dict] = []

    async def null_sink(event: dict) -> None:
        return None

    for index, (job, tasks) in enumerate(zip(jobs, splits)):
        result = await run_job(
            job["job"],
            stream=EventStream(null_sink),
            llm=llm,
            rep=rep,
            price_weight=arm.price_weight,
            fixed_agent_id=arm.fixed_agent_id,
            tasks=tasks,
        )
        for entry in result.ledger.entries():
            if entry.purpose in by_purpose:
                by_purpose[entry.purpose] += entry.cost_usd
        job_grades = []
        for task in result.final["tasks"]:
            if task["agent_id"] is not None:
                wins[task["agent_id"]][task["type"]] += 1
            if task["grade"] is None:
                failed_tasks += 1
            else:
                job_grades.append(task["grade"])
        grades.extend(job_grades)
        per_job.append({
            "job_idx": index,
            "job_id": job["id"],
            "status": result.status,
            "grade_mean": round(sum(job_grades) / len(job_grades), 2) if job_grades else None,
            "cost_usd": result.ledger.total_cost(),
        })

    bid_usd, work_usd, review_usd = (round(by_purpose[p], 6) for p in ("bid", "work", "review"))
    grade_points = sum(grades)
    return {
        "arm": arm.name,
        "price_weight": arm.price_weight if arm.fixed_agent_id is None else None,
        "fixed_agent_id": arm.fixed_agent_id,
        "total_usd": round(bid_usd + work_usd + review_usd, 6),
        "work_usd": work_usd,
        "bid_usd": bid_usd,
        "review_usd": review_usd,
        "mean_grade": round(grade_points / len(grades), 2) if grades else None,
        "graded_tasks": len(grades),
        "failed_tasks": failed_tasks,
        "usd_per_grade_point": round((bid_usd + work_usd) / grade_points, 6) if grade_points else None,
        "wins": wins,
        "rep_final": rep.snapshot() if arm.fixed_agent_id is None else None,
        "per_job": per_job,
    }


def estimate(arms: list[Arm], jobs: list[dict], splits_dir: Path) -> dict:
    """Upper-bound USD estimate without making any calls."""
    def price(model: str, tokens: tuple[int, int]) -> float:
        return cost_usd(config.resolve_model(model), *tokens)

    task_counts = []
    uncached = 0
    for job in jobs:
        path = _split_path(splits_dir, job["job"])
        if path.exists():
            task_counts.append(len(json.loads(path.read_text(encoding="utf-8"))["tasks"]))
        else:
            task_counts.append(ASSUMED_TASKS_PER_JOB)
            uncached += 1
    tasks = sum(task_counts)
    models = {a.agent_id: a.model for a in config.AGENTS}
    review = price(config.REVIEWER_MODEL, EST_SMALL)
    rows = []
    for arm in arms:
        if arm.fixed_agent_id is None:
            bids = sum(price(m, EST_SMALL) for m in models.values())
            work = max(price(m, EST_WORK) for m in models.values())  # assume priciest winner
            calls = tasks * 5
            usd = tasks * (bids + work + review)
        else:
            calls = tasks * 2
            usd = tasks * (price(models[arm.fixed_agent_id], EST_WORK) + review)
        rows.append({"arm": arm.name, "calls": calls, "usd_upper_bound": round(usd, 4)})
    split_usd = uncached * price(config.ORCHESTRATOR_MODEL, EST_SMALL)
    return {
        "real_models": config.real_models(),
        "jobs": len(jobs),
        "tasks": tasks,
        "uncached_splits": uncached,
        "split_usd_upper_bound": round(split_usd, 4),
        "arms": rows,
        "total_usd_upper_bound": round(split_usd + sum(r["usd_upper_bound"] for r in rows), 4),
    }


def markdown_table(results: dict) -> str:
    arms = sorted(results["arms"], key=lambda a: a["total_usd"])
    lines = [
        "| arm | total $ | work $ | bid $ | review $ | mean grade | $/grade pt | wins H/S/O |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for a in arms:
        wins = "/".join(str(sum(a["wins"][agent.agent_id].values())) for agent in config.AGENTS)
        lines.append(
            f"| {a['arm']} | {a['total_usd']:.4f} | {a['work_usd']:.4f} | {a['bid_usd']:.4f} "
            f"| {a['review_usd']:.4f} | {a['mean_grade']} | {a['usd_per_grade_point']} | {wins} |"
        )
    opus = next((a for a in arms if a["arm"] == "fixed:opus"), None)
    if opus and opus["total_usd"] > 0:
        lines.append("")
        for a in arms:
            if a["fixed_agent_id"] is None:
                lines.append(
                    f"- **{a['arm']}**: {a['total_usd'] / opus['total_usd']:.0%} of all-Opus cost, "
                    f"mean grade {a['mean_grade']} vs {opus['mean_grade']}"
                )
    return "\n".join(lines) + "\n"


async def run_experiment(
    arms: list[Arm],
    jobs: list[dict],
    *,
    splits_dir: Path,
    results_dir: Path,
    concurrency: int = 1,
) -> tuple[dict, Path]:
    llm = LLM()
    splits, split_usd, split_calls = [], 0.0, 0
    for job in jobs:
        tasks, usd, calls = await get_split(llm, job["job"], splits_dir)
        splits.append(tasks)
        split_usd += usd
        split_calls += calls

    # Arms may run in parallel; jobs within an arm never do (reputation order matters).
    semaphore = asyncio.Semaphore(max(1, concurrency))

    async def guarded(arm: Arm) -> dict:
        async with semaphore:
            return await run_arm(arm, jobs, splits, llm)

    arm_results = await asyncio.gather(*(guarded(arm) for arm in arms))
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    results = {
        "created_utc": stamp,
        "config": {
            "real_models": config.real_models(),
            "fake_llm": config.fake_llm(),
            "agents": {a.agent_id: a.model for a in config.AGENTS},
            "orchestrator_model": config.ORCHESTRATOR_MODEL,
            "reviewer_model": config.REVIEWER_MODEL,
            "rep_alpha": config.REP_ALPHA,
        },
        "jobs": [job["id"] for job in jobs],
        "split_usd": round(split_usd, 6),
        "split_calls": split_calls,
        "arms": arm_results,
    }
    results_dir.mkdir(parents=True, exist_ok=True)
    json_path = results_dir / f"{stamp}.json"
    json_path.write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
    json_path.with_suffix(".md").write_text(markdown_table(results), encoding="utf-8")
    return results, json_path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Abyss cost/quality experiment")
    parser.add_argument("--jobs", type=Path, default=EXPERIMENTS_DIR / "jobs.json")
    parser.add_argument("--arms", default="all")
    parser.add_argument("--estimate", action="store_true")
    parser.add_argument("--concurrency", type=int, default=1)
    parser.add_argument("--splits-dir", type=Path, default=EXPERIMENTS_DIR / "splits")
    parser.add_argument("--results-dir", type=Path, default=EXPERIMENTS_DIR / "results")
    args = parser.parse_args(argv)

    arms = parse_arms(args.arms)
    jobs = load_jobs(args.jobs)
    if args.estimate:
        print(json.dumps(estimate(arms, jobs, args.splits_dir), indent=2))
        return 0
    results, path = asyncio.run(
        run_experiment(
            arms, jobs,
            splits_dir=args.splits_dir,
            results_dir=args.results_dir,
            concurrency=args.concurrency,
        )
    )
    print(markdown_table(results))
    print(f"split: ${results['split_usd']:.6f} ({results['split_calls']} calls)")
    print(f"wrote {path} and {path.with_suffix('.md')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
