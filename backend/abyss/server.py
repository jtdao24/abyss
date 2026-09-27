"""WebSocket server: one shared market.

Any connection (the terminal chat, a browser view) can start a job or steer
it; every job event is broadcast to every connection. A connection that joins
mid-job first receives the current job's events so far. Closing a connection
never cancels the market's job.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles

from . import attachments, config, mcp_admin, tools
from .contract import validate_event
from .events import EventStream, hello_data
from .llm import LLM
from .market import Guidance, run_job
from .reputation import ReputationStore
from .estimate import estimate_session
from .sessions import SessionStore, usage_summary, vendor_stats


logger = logging.getLogger(__name__)
app = FastAPI()
reputation = ReputationStore(config.rep_path())
llm = LLM()

STEER_TARGETS = {"job", *(agent.agent_id for agent in config.AGENTS)}
sessions = SessionStore()
_provider_llms: dict[str, LLM] = {}


def llm_for(provider: str | None) -> LLM:
    """The default LLM, or one pinned to the provider a session picked."""
    if provider is None or provider == config.provider():
        return llm
    if provider not in _provider_llms:
        _provider_llms[provider] = LLM(provider=provider)
    return _provider_llms[provider]


class Market:
    """The one running job and everyone watching it."""

    def __init__(self) -> None:
        self.clients: set[WebSocket] = set()
        self.stream = EventStream(self.broadcast)
        self.stream.seq = 1  # 0 is each connection's own hello
        self.running: asyncio.Task | None = None
        self.guidance: Guidance | None = None
        self.backlog: list[dict] = []  # the current (or last) job's events
        # Joining (hello + catch-up) and broadcasting take turns, so a viewer that
        # joins mid-job neither misses an event nor sees one out of order.
        self.lock = asyncio.Lock()
        self.tools_changed = False  # mcp.json changed mid-session: reload when it ends

    @property
    def busy(self) -> bool:
        return self.running is not None and not self.running.done()

    async def broadcast(self, event: dict) -> None:
        async with self.lock:
            if event["job_id"] is not None:
                self.backlog.append(event)
            for ws in list(self.clients):
                try:
                    await ws.send_json(event)
                except Exception:  # a closed socket must not stop the market
                    self.clients.discard(ws)
        sessions.observe(event)

    async def join(self, ws: WebSocket) -> None:
        hello = {"v": 1, "seq": 0, "t": 0, "job_id": None, "type": "hello", "data": hello_data(reputation)}
        validate_event(hello)
        async with self.lock:
            await ws.send_json(hello)
            for event in self.backlog:
                await ws.send_json(event)
            self.clients.add(ws)

    async def reply_error(self, ws: WebSocket, message: str) -> None:
        """An error for one connection only (bad message, busy market, ...)."""
        await ws.send_json(self.stream.stamp("error", {"message": message, "task_id": None, "fatal": False}, job_id=None))

    def start(
        self,
        job: str,
        price_weight: float,
        provider: str | None = None,
        budget_usd: float | None = None,
        attachment_ids: list[str] | None = None,
        tool_servers: list[str] | None = None,
    ) -> None:
        self.backlog = []
        self.guidance = Guidance()
        context, names = attachments.context_for(attachment_ids or [])
        sessions.expect(job, provider, budget_usd, names, tool_servers)
        self.running = asyncio.create_task(
            self._run(job, price_weight, self.guidance, llm_for(provider), budget_usd, context, names, tool_servers)
        )

    async def _run(
        self,
        job: str,
        price_weight: float,
        guidance: Guidance,
        job_llm: LLM | None = None,
        budget_usd: float | None = None,
        context: str | None = None,
        context_names: list[str] | None = None,
        tool_servers: list[str] | None = None,
    ) -> None:
        # Which MCP servers the vendors may use this session (None: all of them).
        tools.ALLOWED.set(frozenset(tool_servers) if tool_servers is not None else None)
        # A crashed job must tell everyone instead of leaving them waiting forever.
        try:
            await run_job(
                job, stream=self.stream, llm=job_llm or llm, rep=reputation, price_weight=price_weight,
                guidance=guidance, budget_usd=budget_usd, context=context or None, context_names=context_names or None,
            )
        except Exception as exc:
            logger.exception("job crashed")
            with contextlib.suppress(Exception):
                await self.stream.emit(
                    "error", {"message": f"internal error: {exc}", "task_id": None, "fatal": True}, job_id=None
                )
        finally:
            if self.tools_changed:  # the Tools panel changed mcp.json mid-session
                self.tools_changed = False
                with contextlib.suppress(Exception):
                    await tools.shared().reload()


market = Market()


@app.get("/health")
async def health() -> dict[str, bool]:
    return {"ok": True}


# ---------------------------------------------------------------- local API
@app.get("/api/providers")
async def api_providers() -> list[dict]:
    """AIs this machine has keys for, the default first. Never includes keys."""
    return [{"id": p, "label": config.PROVIDER_LABELS.get(p, p)} for p in config.available_providers()]


@app.get("/api/prices")
async def api_prices() -> dict:
    """Which model serves each vendor per provider, and every model's price."""
    agents = {agent.agent_id: agent.model for agent in config.AGENTS}
    return {
        "default_provider": config.provider(),
        "fake": config.fake_llm(),
        "test_mode": not config.real_models(),
        "tiers": {
            name: {agent_id: config.served_model(name, model) for agent_id, model in agents.items()}
            for name in config.available_providers()
        },
        "prices": {model: list(price) for model, price in config.PRICES.items()},
    }


@app.get("/api/sessions")
async def api_sessions() -> list[dict]:
    return sessions.summaries()


@app.get("/api/sessions/{job_id}")
async def api_session(job_id: str) -> dict:
    record = sessions.get(job_id)
    if record is None:
        raise HTTPException(404, "no such session")
    return record


@app.get("/api/usage")
async def api_usage() -> dict:
    return usage_summary(sessions)


@app.post("/api/attachments")
async def api_attach(request: Request) -> dict:
    """Add a file ({name, data_base64}) or a link ({url}) as reference material."""
    try:
        body = await request.json()
    except ValueError:
        raise HTTPException(400, "send JSON: {name, data_base64} or {url}")
    if not isinstance(body, dict):
        raise HTTPException(400, "send JSON: {name, data_base64} or {url}")
    try:
        record = await attachments.create(body)
    except attachments.AttachmentError as exc:
        raise HTTPException(400, str(exc))
    return attachments.public(record)


@app.get("/api/vendors")
async def api_vendors() -> dict:
    """Each vendor across every saved session: wins, grades vs promises, reputation over time."""
    return vendor_stats(sessions, reputation.snapshot())


# ------------------------------------------------------------------ MCP tools
def _local_only(request: Request) -> None:
    """Tool changes can start programs, so only this machine's page may make
    them: JSON only (no cross-site form posts) and a localhost Origin."""
    if not request.headers.get("content-type", "").startswith("application/json"):
        raise HTTPException(415, "send JSON")
    origin = request.headers.get("origin")
    if origin:
        from urllib.parse import urlparse

        if urlparse(origin).hostname not in ("localhost", "127.0.0.1", "::1", "[::1]"):
            raise HTTPException(403, "tool settings can only be changed from this computer")


async def _json_body(request: Request) -> dict:
    _local_only(request)
    try:
        body = await request.json()
    except ValueError:
        raise HTTPException(400, "send a JSON object")
    if not isinstance(body, dict):
        raise HTTPException(400, "send a JSON object")
    return body


async def _apply_tool_changes() -> None:
    if market.busy:
        market.tools_changed = True  # reload when this session ends
    else:
        await tools.shared().reload()


def _tools_view() -> dict:
    hub = tools.shared()
    return mcp_admin.overview(hub.status(), hub.activity(), hub.config_error, market.tools_changed)


@app.get("/api/mcp")
async def api_mcp() -> dict:
    """MCP servers, their status and tools, the catalog, and recent tool calls."""
    hub = tools.shared()
    if not hub._loaded:
        await hub.reload()
    return _tools_view()


@app.post("/api/mcp/servers")
async def api_mcp_add(request: Request) -> dict:
    """Add a server: {catalog_id, name?, params?, secrets?} or {name, custom: {command, args, env} | {url, headers}}."""
    body = await _json_body(request)
    try:
        if body.get("catalog_id"):
            mcp_admin.add_from_catalog(body["catalog_id"], body.get("name"), body.get("params"), body.get("secrets"))
        else:
            mcp_admin.add_custom(body.get("name", ""), body.get("custom") or {}, body.get("secrets"))
    except mcp_admin.McpConfigError as exc:
        raise HTTPException(400, str(exc))
    await _apply_tool_changes()
    return _tools_view()


@app.post("/api/mcp/servers/{name}")
async def api_mcp_update(name: str, request: Request) -> dict:
    """Change a server: {disabled?, secrets?, allow?}."""
    body = await _json_body(request)
    try:
        mcp_admin.update(
            name, disabled=body.get("disabled"), secrets=body.get("secrets"), allow=body.get("allow", False)
        )
    except mcp_admin.McpConfigError as exc:
        raise HTTPException(400, str(exc))
    await _apply_tool_changes()
    return _tools_view()


@app.delete("/api/mcp/servers/{name}")
async def api_mcp_remove(name: str, request: Request) -> dict:
    origin = request.headers.get("origin")
    if origin:
        from urllib.parse import urlparse

        if urlparse(origin).hostname not in ("localhost", "127.0.0.1", "::1", "[::1]"):
            raise HTTPException(403, "tool settings can only be changed from this computer")
    try:
        mcp_admin.remove(name)
    except mcp_admin.McpConfigError as exc:
        raise HTTPException(400, str(exc))
    await _apply_tool_changes()
    return _tools_view()


@app.post("/api/mcp/reload")
async def api_mcp_reload(request: Request) -> dict:
    """Restart every server (after installing Node.js or uv, say)."""
    await _json_body(request)
    await _apply_tool_changes()
    return _tools_view()


@app.on_event("shutdown")
async def _close_tools() -> None:
    with contextlib.suppress(Exception):
        await tools.shared().close()


@app.get("/api/estimate")
async def api_estimate(provider: str | None = None) -> dict:
    """What a typical session will cost on this AI, before starting it (no calls)."""
    return estimate_session(provider)


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    await market.join(ws)
    try:
        while True:
            raw = await ws.receive_text()
            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                await market.reply_error(ws, "invalid JSON")
                continue
            if not isinstance(message, dict):
                await market.reply_error(ws, "message must be a JSON object")
                continue

            message_type = message.get("type")
            if message_type == "start_job":
                error = "a job is already running" if market.busy else _validate_start(message)
                if error is not None:
                    await market.reply_error(ws, error)
                    continue
                market.start(
                    message["job"],
                    message.get("price_weight", config.PRICE_WEIGHT),
                    message.get("provider"),
                    message.get("budget_usd"),
                    message.get("attachments"),
                    message.get("tools"),
                )
            elif message_type == "steer":
                error = _validate_steer(message)
                if error is None and (not market.busy or market.guidance is None):
                    error = "no job is running to steer"
                if error is not None:
                    await market.reply_error(ws, error)
                    continue
                note = message["note"].strip()
                market.guidance.add(message["target"], note)
                await market.stream.emit("steered", {"target": message["target"], "note": note})
            elif message_type == "reset":
                if market.busy:
                    await market.reply_error(ws, "cannot reset while a job is running")
                    continue
                reputation.reset()
                await market.stream.hello(reputation)
            else:
                await market.reply_error(ws, "unknown message type")
    except WebSocketDisconnect:
        pass
    finally:
        market.clients.discard(ws)


def _validate_steer(message: dict) -> str | None:
    if message.get("target") not in STEER_TARGETS:
        return "steer target must be 'job' or an agent id"
    note = message.get("note")
    if not isinstance(note, str) or not note.strip() or len(note) > 500:
        return "steer note must be a string between 1 and 500 characters"
    return None


def _validate_start(message: dict) -> str | None:
    job = message.get("job")
    if not isinstance(job, str) or not job.strip() or len(job) > 2000:
        return "job must be a string between 1 and 2000 characters"
    price_weight = message.get("price_weight", config.PRICE_WEIGHT)
    if (
        isinstance(price_weight, bool)
        or not isinstance(price_weight, (int, float))
        or not 0 <= price_weight <= 10
    ):
        return "price_weight must be between 0 and 10"
    provider = message.get("provider")
    if provider is not None and provider not in config.available_providers():
        return f"{config.PROVIDER_LABELS.get(provider, provider)} has no API key on this machine"
    budget = message.get("budget_usd")
    if budget is not None and (
        isinstance(budget, bool) or not isinstance(budget, (int, float)) or not 0 < budget <= 100
    ):
        return "budget_usd must be more than $0 and at most $100"
    ids = message.get("attachments")
    if ids is not None:
        if not isinstance(ids, list) or len(ids) > attachments.MAX_ATTACHMENTS:
            return f"attachments must be a list of at most {attachments.MAX_ATTACHMENTS} ids"
        if any(not isinstance(i, str) or attachments.load(i) is None for i in ids):
            return "an attachment is missing; add the file or link again"
    servers = message.get("tools")
    if servers is not None and (
        not isinstance(servers, list) or len(servers) > 50 or not all(isinstance(s, str) for s in servers)
    ):
        return "tools must be a list of MCP server names"
    return None


# The built market view (web/dist), served at / so the whole tool is one port.
# Mounted last so /api, /ws and /health win. `npm run dev` doesn't need it.
_DIST = config.REPO_ROOT / "web" / "dist"
if (_DIST / "index.html").exists():
    app.mount("/", StaticFiles(directory=_DIST, html=True), name="web")
