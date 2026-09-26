from __future__ import annotations

import json

import pytest

from abyss import experiment
from abyss.experiment import Arm, estimate, load_jobs, parse_arms, run_experiment


JOBS = [
    {"id": "a", "kind": "explainer", "job": "Explain tides in 80 words, then fact-check it."},
    {"id": "b", "kind": "trap", "job": "Explain why goldfish have 3-second memories, then fact-check it."},
]


@pytest.fixture
def fake_env(monkeypatch, tmp_path):
    monkeypatch.setenv("ABYSS_FAKE_LLM", "1")
    monkeypatch.setenv("ABYSS_FAKE_DELAY", "0")
    monkeypatch.setenv("ABYSS_LEDGER_PATH", str(tmp_path / "ledger.jsonl"))
    return tmp_path


def test_parse_arms() -> None:
    arms = parse_arms("all")
    assert [a.name for a in arms] == [
        "market@0", "market@1", "market@3", "fixed:haiku", "fixed:sonnet", "fixed:opus",
    ]
    assert parse_arms("market@1.5")[0] == Arm("market@1.5", 1.5, None)
    assert parse_arms("fixed:opus")[0].fixed_agent_id == "opus"
    with pytest.raises(ValueError):
        parse_arms("fixed:gpt")


def test_repo_jobs_file_loads() -> None:
    jobs = load_jobs(experiment.EXPERIMENTS_DIR / "jobs.json")
    assert len(jobs) == 6
    assert len({job["id"] for job in jobs}) == 6


async def test_fake_run_writes_results_and_fixed_arms_skip_bids(fake_env) -> None:
    results, path = await run_experiment(
        parse_arms("market@1,fixed:haiku"),
        JOBS,
        splits_dir=fake_env / "splits",
        results_dir=fake_env / "results",
    )
    assert path.exists() and path.with_suffix(".md").exists()
    assert json.loads(path.read_text()) == results
    market, fixed = results["arms"]
    assert market["bid_usd"] > 0
    assert fixed["bid_usd"] == 0
    assert fixed["rep_final"] is None
    assert market["rep_final"] is not None
    assert sum(fixed["wins"]["haiku"].values()) == market["graded_tasks"] == 6
    assert [job["job_id"] for job in market["per_job"]] == ["a", "b"]
    assert results["split_calls"] == 2


async def test_split_cache_is_reused(fake_env) -> None:
    kwargs = dict(splits_dir=fake_env / "splits", results_dir=fake_env / "results")
    first, _ = await run_experiment(parse_arms("fixed:haiku"), JOBS, **kwargs)
    second, _ = await run_experiment(parse_arms("fixed:haiku"), JOBS, **kwargs)
    assert first["split_calls"] == 2
    assert second["split_calls"] == 0
    assert second["split_usd"] == 0
    ledger = [json.loads(line) for line in (fake_env / "ledger.jsonl").read_text().splitlines()]
    assert sum(entry["purpose"] == "split" for entry in ledger) == 2


def test_estimate_makes_no_calls(fake_env, monkeypatch) -> None:
    async def boom(*args, **kwargs):
        raise AssertionError("estimate must not call the model")

    monkeypatch.setattr(experiment, "split_job", boom)
    est = estimate(parse_arms("all"), JOBS, fake_env / "splits")
    assert est["tasks"] == 6 and est["uncached_splits"] == 2
    by_arm = {row["arm"]: row for row in est["arms"]}
    assert by_arm["market@1"]["calls"] == 30
    assert by_arm["fixed:opus"]["calls"] == 12
    assert est["total_usd_upper_bound"] > 0
