from __future__ import annotations

from copy import deepcopy

import pytest

from abyss.contract import validate_stream


def test_fixture_passes(fixture_events: list[dict]) -> None:
    validate_stream(fixture_events)


def test_every_data_key_is_required(fixture_events: list[dict]) -> None:
    for event_index, event in enumerate(fixture_events):
        for key in event["data"]:
            changed = deepcopy(fixture_events)
            del changed[event_index]["data"][key]
            with pytest.raises(Exception):
                validate_stream(changed)


def test_unknown_data_key_fails(fixture_events: list[dict]) -> None:
    for event_index in range(len(fixture_events)):
        changed = deepcopy(fixture_events)
        changed[event_index]["data"]["unknown"] = "not allowed"
        with pytest.raises(Exception):
            validate_stream(changed)


def test_won_before_last_bid_fails(fixture_events: list[dict]) -> None:
    changed = deepcopy(fixture_events)
    bid_index = next(
        index
        for index, event in enumerate(changed)
        if event["type"] == "bid" and event["data"]["task_id"] == "t1"
    )
    won_index = next(
        index
        for index, event in enumerate(changed)
        if event["type"] == "won" and event["data"]["task_id"] == "t1"
    )
    changed[bid_index], changed[won_index] = changed[won_index], changed[bid_index]
    for seq, event in enumerate(changed):
        event["seq"] = seq

    with pytest.raises(Exception):
        validate_stream(changed)
