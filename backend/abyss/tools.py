"""MCP tools for the working vendors (Slack, Discord, Notion, ...).

Servers are listed in `mcp.json` at the repo root (or `ABYSS_MCP_CONFIG`), in
the same shape Claude Code uses:

    {"mcpServers": {
        "notion": {"command": "npx", "args": ["-y", "@notionhq/notion-mcp-server"],
                   "env": {"NOTION_TOKEN": "${NOTION_TOKEN}"}},
        "remote": {"url": "https://example.com/mcp",
                   "headers": {"Authorization": "Bearer ${REMOTE_TOKEN}"},
                   "allow": ["search"]}}}

`${VAR}` is filled from the environment (so secrets stay in .env). `allow`
limits which of a server's tools the vendors see. A server that fails to start
is logged and skipped; the market runs without it.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
import shutil
import time
from collections import deque
from contextvars import ContextVar
from pathlib import Path
from typing import Any

from . import config


logger = logging.getLogger(__name__)
TOOL_RESULT_MAX_CHARS = 20_000
_VAR = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")


def load_servers(path: Path | None = None, skip_missing_keys: bool = False) -> dict[str, dict]:
    path = path or config.mcp_config_path()
    if not path.exists():
        return {}
    raw = json.loads(path.read_text(encoding="utf-8"))
    servers = raw.get("mcpServers", {})
    if not isinstance(servers, dict):
        raise ValueError(f"{path}: mcpServers must be an object")
    return {
        name: _expand(spec)
        for name, spec in servers.items()
        if not spec.get("disabled")
        and not (skip_missing_keys and any(not os.environ.get(var) for var in _VAR.findall(json.dumps(spec))))
    }


def _expand(value: Any) -> Any:
    if isinstance(value, str):
        return _VAR.sub(lambda m: os.environ.get(m.group(1), ""), value)
    if isinstance(value, list):
        return [_expand(item) for item in value]
    if isinstance(value, dict):
        return {key: _expand(item) for key, item in value.items()}
    return value


def tool_name(server: str, tool: str) -> str:
    """The API allows [a-zA-Z0-9_-]{1,64}; keep the server prefix readable."""
    return re.sub(r"[^a-zA-Z0-9_-]", "_", f"{server}__{tool}")[:64]


# The servers this job may use (start_job `tools`); None means every server.
ALLOWED: ContextVar[frozenset[str] | None] = ContextVar("abyss_mcp_allowed", default=None)
# Who is calling (agent id, task id), for the activity feed.
CALLER: ContextVar[tuple[str | None, str | None]] = ContextVar("abyss_mcp_caller", default=(None, None))
START_TIMEOUT_SECONDS = float(os.getenv("ABYSS_MCP_START_TIMEOUT", "60"))
ACTIVITY_SIZE = 60


class ToolHub:
    """Keeps every MCP server connected for the life of the process.

    The MCP transports must be opened and closed by the same task, so each
    server gets one background task that connects it and parks until
    `close()`. A slow server (npx downloading a package) never holds up the
    others: `start()` waits a while, and a late server joins when it is ready.
    """

    def __init__(self, servers: dict[str, dict]) -> None:
        self.servers = servers
        self._sessions: dict[str, Any] = {}
        self._routes: dict[str, tuple[str, str]] = {}  # api name -> (server, mcp tool)
        self._definitions: list[dict] = []
        self.status: dict[str, dict] = {name: {"state": "starting", "error": None, "tools": []} for name in servers}
        self.activity: deque[dict] = deque(maxlen=ACTIVITY_SIZE)
        self._settled: dict[str, asyncio.Event] = {name: asyncio.Event() for name in servers}
        self._closing = asyncio.Event()
        self._owners: dict[str, asyncio.Task] = {}

    @classmethod
    def from_config(cls) -> ToolHub | None:
        servers = load_servers()
        return cls(servers) if servers else None

    async def start(self, timeout: float | None = None) -> None:
        if not self._owners:
            for name, spec in self.servers.items():
                self._owners[name] = asyncio.create_task(self._own(name, spec))
        waits = [asyncio.create_task(event.wait()) for event in self._settled.values()]
        if waits:
            await asyncio.wait(waits, timeout=START_TIMEOUT_SECONDS if timeout is None else timeout)
            for wait in waits:
                wait.cancel()

    async def close(self) -> None:
        self._closing.set()
        for name, task in self._owners.items():
            if not self._settled[name].is_set():
                task.cancel()  # still connecting: give up on it
        for task in self._owners.values():
            with contextlib.suppress(BaseException):
                await task

    def definitions(self) -> list[dict]:
        allowed = ALLOWED.get()
        if allowed is None:
            return list(self._definitions)
        return [d for d in self._definitions if self._routes[d["name"]][0] in allowed]

    async def call(self, name: str, arguments: dict) -> tuple[str, bool]:
        """Run one tool. Returns (text for the model, is_error)."""
        route = self._routes.get(name)
        allowed = ALLOWED.get()
        if route is None or (allowed is not None and route[0] not in allowed):
            return f"unknown tool {name}", True
        server, tool = route
        started = time.monotonic()
        try:
            result = await self._sessions[server].call_tool(tool, arguments)
        except Exception as exc:
            logger.warning("tool %s failed: %s", name, exc)
            self._log(server, tool, arguments, started, f"tool error: {exc}", True)
            return f"tool error: {exc}", True
        text = _result_text(result)
        if len(text) > TOOL_RESULT_MAX_CHARS:
            text = text[:TOOL_RESULT_MAX_CHARS] + "\n[truncated]"
        self._log(server, tool, arguments, started, text, bool(result.is_error))
        return text, bool(result.is_error)

    def _log(self, server: str, tool: str, arguments: dict, started: float, text: str, is_error: bool) -> None:
        agent_id, task_id = CALLER.get()
        self.activity.append({
            "t": time.time(), "server": server, "tool": tool, "agent_id": agent_id, "task_id": task_id,
            "ok": not is_error, "ms": int((time.monotonic() - started) * 1000),
            "args": json.dumps(arguments, default=str)[:200], "result": text[:300],
        })

    async def _own(self, name: str, spec: dict) -> None:
        try:
            async with contextlib.AsyncExitStack() as stack:
                try:
                    await self._connect(stack, name, spec)
                except Exception as exc:
                    logger.warning("MCP server %r did not start: %s", name, exc)
                    self.status[name] = {"state": "failed", "error": _short_error(exc), "tools": []}
                    return
                self.status[name]["state"] = "ready"
                logger.info("MCP server %r ready: %d tools", name, len(self.status[name]["tools"]))
                self._settled[name].set()
                await self._closing.wait()
        except asyncio.CancelledError:
            self.status[name] = {"state": "failed", "error": "stopped before it finished starting", "tools": []}
        except BaseException as exc:  # a crashed transport must not take the market down
            logger.warning("MCP server %r stopped: %s", name, exc)
            self.status[name] = {"state": "failed", "error": _short_error(exc), "tools": []}
        finally:
            self._drop(name)
            self._settled[name].set()  # never leave a caller waiting on a crashed server

    def _drop(self, name: str) -> None:
        gone = {api for api, (server, _) in self._routes.items() if server == name}
        for api in gone:
            del self._routes[api]
        self._definitions = [d for d in self._definitions if d["name"] not in gone]
        self._sessions.pop(name, None)

    async def _connect(self, stack: contextlib.AsyncExitStack, name: str, spec: dict) -> None:
        from mcp import ClientSession

        if "url" in spec:
            import httpx2
            from mcp.client.streamable_http import streamable_http_client

            http = await stack.enter_async_context(httpx2.AsyncClient(headers=spec.get("headers", {})))
            read, write = await stack.enter_async_context(streamable_http_client(spec["url"], http_client=http))
        else:
            from mcp.client.stdio import StdioServerParameters, get_default_environment, stdio_client

            command = shutil.which(spec["command"]) or spec["command"]  # npx is npx.cmd on Windows
            params = StdioServerParameters(
                command=command,
                args=spec.get("args", []),
                env={**get_default_environment(), **spec.get("env", {})},
            )
            read, write = await stack.enter_async_context(stdio_client(params))
        session = await stack.enter_async_context(ClientSession(read, write))
        await session.initialize()

        allow = spec.get("allow")
        listed = await session.list_tools()
        self._sessions[name] = session
        tools = []
        for tool in listed.tools:
            if allow is not None and tool.name not in allow:
                continue
            api_name = tool_name(name, tool.name)
            self._routes[api_name] = (name, tool.name)
            description = (tool.description or tool.title or tool.name)[:1024]
            self._definitions.append({
                "name": api_name,
                "description": description,
                "input_schema": tool.input_schema or {"type": "object", "properties": {}},
            })
            tools.append({"name": tool.name, "description": description[:200]})
        self.status[name]["tools"] = tools


def _short_error(exc: BaseException) -> str:
    """ExceptionGroups (anyio) hide the real cause one level down."""
    while isinstance(exc, BaseExceptionGroup) and exc.exceptions:
        exc = exc.exceptions[0]
    return (f"{type(exc).__name__}: {exc}" if str(exc) else type(exc).__name__)[:300]


class SharedTools:
    """The one set of MCP servers every LLM shares, reloadable from the Tools panel.

    Same interface as ToolHub (start, definitions, call, close), so the LLM
    doesn't care. `reload()` swaps in a fresh hub built from mcp.json.
    """

    def __init__(self) -> None:
        self.hub: ToolHub | None = None
        self.config_error: str | None = None
        self._loaded = False
        self._lock = asyncio.Lock()
        self._recent: deque[dict] = deque(maxlen=ACTIVITY_SIZE)  # survives reloads

    def _build(self) -> None:
        self._loaded = True
        try:
            servers = load_servers(skip_missing_keys=True)
            self.config_error = None
        except (OSError, ValueError) as exc:  # a broken mcp.json must not stop the market
            logger.warning("ignoring MCP config: %s", exc)
            servers, self.config_error = {}, str(exc)
        self.hub = ToolHub(servers) if servers else None
        if self.hub is not None:
            self.hub.activity = self._recent

    async def start(self) -> None:
        if not self._loaded:
            self._build()
        if self.hub is not None:
            await self.hub.start()

    def definitions(self) -> list[dict]:
        return self.hub.definitions() if self.hub is not None else []

    async def call(self, name: str, arguments: dict) -> tuple[str, bool]:
        if self.hub is None:
            return f"unknown tool {name}", True
        return await self.hub.call(name, arguments)

    async def close(self) -> None:
        if self.hub is not None:
            await self.hub.close()

    async def reload(self) -> None:
        async with self._lock:
            old = self.hub
            self._build()
            if old is not None:
                await old.close()
            if self.hub is not None:
                # Don't make the caller wait for slow installs; the status shows progress.
                await self.hub.start(timeout=5)

    def status(self) -> dict[str, dict]:
        return dict(self.hub.status) if self.hub is not None else {}

    def activity(self) -> list[dict]:
        return list(self._recent)


_shared: SharedTools | None = None


def shared() -> SharedTools:
    global _shared
    if _shared is None:
        _shared = SharedTools()
    return _shared


def _result_text(result: Any) -> str:
    parts: list[str] = []
    for item in result.content:
        if getattr(item, "type", None) == "text":
            parts.append(item.text)
        else:
            parts.append(f"[{getattr(item, 'type', 'content')} omitted]")
    if not parts and result.structured_content is not None:
        parts.append(json.dumps(result.structured_content))
    return "\n".join(parts) or "(no output)"
