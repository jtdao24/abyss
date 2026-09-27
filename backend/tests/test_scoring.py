from __future__ import annotations

from abyss.config import AGENTS
from abyss.scoring import (
    ScoredBid,
    clamp_bid,
    pick_winner,
    predicted_cost,
    score_bid,
)


AGENT_MODELS = {agent.agent_id: agent.model for agent in AGENTS}


def test_fixture_auction_math(fixture_events: list[dict]) -> None:
    posted = {
        event["data"]["task_id"]: event["data"]
        for event in fixture_events
        if event["type"] == "task_posted"
    }
    won_events = [event for event in fixture_events if event["type"] == "won"]

    for won_event in won_events:
        task_id = won_event["data"]["task_id"]
        bids = []
        for event in fixture_events:
            if event["type"] != "bid" or event["data"]["task_id"] != task_id or not event["data"]["ok"]:
                continue
            data = event["data"]
            cost = predicted_cost(
                AGENT_MODELS[data["agent_id"]],
                posted[task_id]["est_input_tokens"],
                data["predicted_output_tokens"],
            )
            score = score_bid(
                data["promised_quality"],
                data["reputation"],
                cost,
                won_event["data"]["price_weight"],
            )
            assert cost == data["predicted_cost_usd"]
            assert score == data["score"]
            bids.append(
                ScoredBid(
                    agent_id=data["agent_id"],
                    promised_quality=data["promised_quality"],
                    predicted_output_tokens=data["predicted_output_tokens"],
                    est_input_tokens=data["est_input_tokens"],
                    predicted_cost_usd=cost,
                    reputation=data["reputation"],
                    score=score,
                )
            )

        winner, runner_up = pick_winner(bids)
        assert winner.agent_id == won_event["data"]["agent_id"]
        assert runner_up is not None
        assert runner_up.agent_id == won_event["data"]["runner_up_agent_id"]


def test_tie_breaks_by_cost_then_agent_order() -> None:
    costly = _bid("haiku", cost=0.02)
    cheap = _bid("opus", cost=0.01)
    assert pick_winner([costly, cheap])[0].agent_id == "opus"

    sonnet = _bid("sonnet", cost=0.01)
    haiku = _bid("haiku", cost=0.01)
    assert pick_winner([sonnet, haiku])[0].agent_id == "haiku"


def test_clamp_bid() -> None:
    tokens, quality, pitch = clamp_bid(
        {
            "predicted_output_tokens": 5,
            "promised_quality": 14,
            "pitch": "x" * 200,
        }
    )
    assert tokens == 50
    assert quality == 10
    assert len(pitch) == 80
    assert clamp_bid(
        {"predicted_output_tokens": 100, "promised_quality": "7", "pitch": "ok"}
    )[1] == 7


def _bid(agent_id: str, *, cost: float) -> ScoredBid:
    return ScoredBid(
        agent_id=agent_id,
        promised_quality=8,
        predicted_output_tokens=100,
        est_input_tokens=100,
        predicted_cost_usd=cost,
        reputation=1.0,
        score=7.0,
    )
