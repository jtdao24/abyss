"""Only this computer may drive the market: other websites open in the browser
can't connect to the live feed, read the API through DNS rebinding, or make
this machine fetch links."""
from __future__ import annotations

import importlib

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

EVIL = "https://evil.example"


@pytest.fixture
def server(monkeypatch, tmp_path):
    monkeypatch.setenv("ABYSS_FAKE_LLM", "1")
    monkeypatch.setenv("ABYSS_FAKE_DELAY", "0")
    monkeypatch.setenv("ABYSS_LEDGER_PATH", str(tmp_path / "ledger.jsonl"))
    monkeypatch.setenv("ABYSS_REP_PATH", str(tmp_path / "reputation.json"))
    monkeypatch.setenv("ABYSS_SESSIONS_DIR", str(tmp_path / "sessions"))
    import abyss.server

    return importlib.reload(abyss.server)


def test_other_websites_cant_open_the_live_feed(server) -> None:
    with TestClient(server.app) as client:
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect("/ws", headers={"origin": EVIL}) as ws:
                ws.receive_json()


@pytest.mark.parametrize("origin", [None, "http://localhost:8000", "http://127.0.0.1:5173"])
def test_this_computer_can(server, origin) -> None:
    headers = {"origin": origin} if origin else {}
    with TestClient(server.app) as client:
        with client.websocket_connect("/ws", headers=headers) as ws:
            assert ws.receive_json()["type"] == "hello"


def test_dns_rebinding_cant_read_the_api(server) -> None:
    with TestClient(server.app) as client:
        assert client.get("/api/sessions", headers={"host": "evil.example:8000"}).status_code == 400
        assert client.get("/api/sessions", headers={"host": "localhost:8000"}).status_code == 200


def test_other_websites_cant_make_this_computer_fetch_links(server) -> None:
    with TestClient(server.app) as client:
        # A cross-site form or text/plain fetch (no browser preflight) is refused...
        plain = client.post("/api/attachments", content='{"url": "http://192.168.1.1/"}', headers={"content-type": "text/plain"})
        assert plain.status_code == 415
        # ...and so is JSON from another site's page.
        cross = client.post("/api/attachments", json={"url": "http://192.168.1.1/"}, headers={"origin": EVIL})
        assert cross.status_code == 403
