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
from pathlib import Path
from typing import Any

from . import config


logger = logging.getLogger(__name__)
TOOL_RESULT_MAX_CHARS = 20_000
_VAR = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")


def load_servers(path: Path | None = None) -> dict[str, dict]:
    path = path or config.mcp_config_path()
    if not path.exists():
        return {}
    raw = json.loads(path.read_text(encoding="utf-8"))
    servers = raw.get("mcpServers", {})
    if not isinstance(servers, dict):
        raise ValueError(f"{path}: mcpServers must be an object")
    return {name: _expand(spec) for name, spec in servers.items() if not spec.get("disabled")}


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


class ToolHub:
    """Keeps every MCP server connected for the life of the process.

    The MCP transports must be opened and closed by the same task, so one
    background task owns them all and parks until `close()`.
    """

    def __init__(self, servers: dict[str, dict]) -> None:
        self.servers = servers
        self._sessions: dict[str, Any] = {}
        self._routes: dict[str, tuple[str, str]] = {}  # api name -> (server, mcp tool)
        self._definitions: list[dict] = []
        self._ready = asyncio.Event()
        self._closing = asyncio.Event()
        self._owner: asyncio.Task | None = None

    @classmethod
    def from_config(cls) -> ToolHub | None:
        servers = load_servers()
        return cls(servers) if servers else None

    async def start(self) -> None:
        if self._owner is None:
            self._owner = asyncio.create_task(self._own())
        await self._ready.wait()

    async def close(self) -> None:
        if self._owner is not None:
            self._closing.set()
            with contextlib.suppress(Exception):
                await self._owner

    def definitions(self) -> list[dict]:
        return self._definitions

    async def call(self, name: str, arguments: dict) -> tuple[str, bool]:
        """Run one tool. Returns (text for the model, is_error)."""
        route = self._routes.get(name)
        if route is None:
            return f"unknown tool {name}", True
        server, tool = route
        try:
            result = await self._sessions[server].call_tool(tool, arguments)
        except Exception as exc:
            logger.warning("tool %s failed: %s", name, exc)
            return f"tool error: {exc}", True
        text = _result_text(result)
        if len(text) > TOOL_RESULT_MAX_CHARS:
            text = text[:TOOL_RESULT_MAX_CHARS] + "\n[truncated]"
        return text, bool(result.is_error)

    async def _own(self) -> None:
        try:
            async with contextlib.AsyncExitStack() as stack:
                for name, spec in self.servers.items():
                    try:
                        await self._connect(stack, name, spec)
                    except Exception as exc:
                        logger.warning("MCP server %r did not start: %s", name, exc)
                logger.info("MCP tools ready: %s", ", ".join(self._routes) or "none")
                self._ready.set()
                await self._closing.wait()
        finally:
            self._ready.set()  # never leave a caller waiting on a crashed hub

    async def _connect(self, stack: contextlib.AsyncExitStack, name: str, spec: dict) -> None:
        from mcp import ClientSession

        if "url" in spec:
            import httpx2
            from mcp.client.streamable_http import streamable_http_client

            http = await stack.enter_async_context(httpx2.AsyncClient(headers=spec.get("headers", {})))
            read, write = await stack.enter_async_context(streamable_http_client(spec["url"], http_client=http))
        else:
            from mcp.client.stdio import StdioServerParameters, get_default_environment, stdio_client

            params = StdioServerParameters(
                command=spec["command"],
                args=spec.get("args", []),
                env={**get_default_environment(), **spec.get("env", {})},
            )
            read, write = await stack.enter_async_context(stdio_client(params))
        session = await stack.enter_async_context(ClientSession(read, write))
        await session.initialize()

        allow = spec.get("allow")
        listed = await session.list_tools()
        self._sessions[name] = session
        for tool in listed.tools:
            if allow is not None and tool.name not in allow:
                continue
            api_name = tool_name(name, tool.name)
            self._routes[api_name] = (name, tool.name)
            self._definitions.append({
                "name": api_name,
                "description": (tool.description or tool.title or tool.name)[:1024],
                "input_schema": tool.input_schema or {"type": "object", "properties": {}},
            })


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
