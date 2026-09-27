from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from abyss import mcp_admin, server, tools
from abyss.tools import ALLOWED, ToolHub

ECHO = str(Path(__file__).with_name("echo_mcp_server.py"))
LOCAL = {"Origin": "http://localhost:8000"}


@pytest.fixture
def mcp_files(tmp_path: Path, monkeypatch) -> tuple[Path, Path]:
    config_file = tmp_path / "mcp.json"
    env_file = tmp_path / ".env"
    monkeypatch.setenv("ABYSS_MCP_CONFIG", str(config_file))
    monkeypatch.setattr(mcp_admin, "ENV_FILE", env_file)
    monkeypatch.setattr(tools, "_shared", None)
    for var in ("BRAVE_API_KEY", "ECHO_TOKEN"):
        monkeypatch.delenv(var, raising=False)
    return config_file, env_file


def test_catalog_add_keeps_secrets_out_of_mcp_json(mcp_files, monkeypatch) -> None:
    config_file, env_file = mcp_files
    monkeypatch.setattr(mcp_admin.os, "environ", dict(mcp_admin.os.environ))
    mcp_admin.add_from_catalog("brave-search", None, None, {"BRAVE_API_KEY": "sk-secret", "EVIL": "x"})
    raw = json.loads(config_file.read_text(encoding="utf-8"))
    spec = raw["mcpServers"]["brave-search"]
    assert spec["env"] == {"BRAVE_API_KEY": "${BRAVE_API_KEY}"}
    assert spec["catalog"] == "brave-search"
    assert "sk-secret" not in config_file.read_text(encoding="utf-8")
    assert env_file.read_text(encoding="utf-8") == "BRAVE_API_KEY=sk-secret\n"
    assert "EVIL" not in env_file.read_text(encoding="utf-8")


def test_catalog_params_fill_the_command(mcp_files) -> None:
    config_file, _ = mcp_files
    with pytest.raises(mcp_admin.McpConfigError, match="required"):
        mcp_admin.add_from_catalog("filesystem", None, {}, None)
    mcp_admin.add_from_catalog("filesystem", "docs", {"folder": "C:\\data"}, None)
    spec = json.loads(config_file.read_text(encoding="utf-8"))["mcpServers"]["docs"]
    assert spec["args"][-1] == "C:\\data"
    with pytest.raises(mcp_admin.McpConfigError, match="already"):
        mcp_admin.add_from_catalog("filesystem", "docs", {"folder": "x"}, None)


def test_save_env_replaces_and_rejects_bad_values(mcp_files, monkeypatch) -> None:
    _, env_file = mcp_files
    monkeypatch.setattr(mcp_admin.os, "environ", {})
    env_file.write_text("# keys\nOPENAI_API_KEY=keep\nECHO_TOKEN=old\n", encoding="utf-8")
    mcp_admin.save_env({"ECHO_TOKEN": "new", "NEW_ONE": "v"})
    assert env_file.read_text(encoding="utf-8") == "# keys\nOPENAI_API_KEY=keep\nECHO_TOKEN=new\nNEW_ONE=v\n"
    with pytest.raises(mcp_admin.McpConfigError):
        mcp_admin.save_env({"ECHO_TOKEN": "a\nB=c"})
    with pytest.raises(mcp_admin.McpConfigError):
        mcp_admin.save_env({"bad name": "v"})


def test_custom_servers_update_and_remove(mcp_files) -> None:
    config_file, _ = mcp_files
    with pytest.raises(mcp_admin.McpConfigError):
        mcp_admin.add_custom("x", {})
    with pytest.raises(mcp_admin.McpConfigError):
        mcp_admin.add_custom("bad name!", {"command": "echo"})
    with pytest.raises(mcp_admin.McpConfigError):
        mcp_admin.add_custom("r", {"url": "file:///etc/passwd"})
    mcp_admin.add_custom("echo", {"command": sys.executable, "args": [ECHO]})
    mcp_admin.update("echo", disabled=True, allow=["shout"])
    spec = json.loads(config_file.read_text(encoding="utf-8"))["mcpServers"]["echo"]
    assert spec["disabled"] is True and spec["allow"] == ["shout"]
    mcp_admin.update("echo", disabled=False, allow=None)
    spec = json.loads(config_file.read_text(encoding="utf-8"))["mcpServers"]["echo"]
    assert "disabled" not in spec and "allow" not in spec
    mcp_admin.remove("echo")
    assert json.loads(config_file.read_text(encoding="utf-8"))["mcpServers"] == {}


def test_overview_shows_missing_keys_never_values(mcp_files, monkeypatch) -> None:
    mcp_admin.add_custom("echo", {"command": sys.executable, "args": [ECHO], "env": {"T": "${ECHO_TOKEN}"}})
    view = mcp_admin.overview({}, [], None, False)
    (echo,) = view["servers"]
    assert echo["state"] == "needs_keys"
    assert echo["missing"] == ["ECHO_TOKEN"]
    monkeypatch.setenv("ECHO_TOKEN", "very-secret")
    view = mcp_admin.overview({}, [], None, False)
    assert view["servers"][0]["keys"] == [{"var": "ECHO_TOKEN", "set": True}]
    assert "very-secret" not in json.dumps(view)
    assert any(entry["id"] == "github" for entry in view["catalog"])


async def test_allowed_servers_filter_tools() -> None:
    hub = ToolHub({"echo": {"command": sys.executable, "args": [ECHO]}})
    try:
        await hub.start()
        assert hub.status["echo"]["state"] == "ready"
        assert {t["name"] for t in hub.status["echo"]["tools"]} == {"shout", "secret"}
        token = ALLOWED.set(frozenset({"other"}))
        try:
            assert hub.definitions() == []
            assert (await hub.call("echo__shout", {"text": "x"}))[1] is True
        finally:
            ALLOWED.reset(token)
        assert await hub.call("echo__shout", {"text": "ahoy"}) == ("AHOY", False)
        assert hub.activity[-1]["tool"] == "shout" and hub.activity[-1]["ok"]
    finally:
        await hub.close()


async def test_a_broken_server_reports_its_error() -> None:
    hub = ToolHub({"nope": {"command": "definitely-not-a-real-command-abyss"}})
    try:
        await hub.start(timeout=20)
        assert hub.status["nope"]["state"] == "failed"
        assert hub.status["nope"]["error"]
        assert hub.definitions() == []
    finally:
        await hub.close()


def test_api_adds_a_server_and_it_connects(mcp_files) -> None:
    with TestClient(server.app) as client:
        body = {"name": "echo", "custom": {"command": sys.executable, "args": [ECHO]}}
        response = client.post("/api/mcp/servers", json=body, headers=LOCAL)
        assert response.status_code == 200, response.text
        (echo,) = response.json()["servers"]
        assert echo["state"] == "ready"
        assert len(echo["tools"]) == 2
        response = client.post("/api/mcp/servers/echo", json={"disabled": True}, headers=LOCAL)
        assert response.json()["servers"][0]["state"] == "disabled"
        assert client.delete("/api/mcp/servers/echo", headers=LOCAL).json()["servers"] == []
        assert client.get("/api/mcp").json()["runtimes"].keys() == {"npx", "uvx"}
        server_tools = tools.shared()
        client.portal.call(server_tools.close)


def test_api_refuses_other_sites_and_forms(mcp_files) -> None:
    with TestClient(server.app) as client:
        body = {"name": "evil", "custom": {"command": "calc"}}
        assert client.post("/api/mcp/servers", json=body, headers={"Origin": "https://evil.example"}).status_code == 403
        form = client.post("/api/mcp/servers", content=json.dumps(body), headers={"Content-Type": "text/plain"})
        assert form.status_code == 415
        assert client.delete("/api/mcp/servers/x", headers={"Origin": "https://evil.example"}).status_code == 403
    assert not mcp_files[0].exists()


def test_start_job_checks_tools_field() -> None:
    assert server._validate_start({"job": "hi", "tools": "slack"}) is not None
    assert server._validate_start({"job": "hi", "tools": [1]}) is not None
    assert server._validate_start({"job": "hi", "tools": ["slack"]}) is None
    assert server._validate_start({"job": "hi", "tools": []}) is None
