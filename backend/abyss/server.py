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
import time

from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import attachments, config, limits, mcp_admin, tools
from .contract import validate_event
from .events import EventStream, hello_data
from .llm import LLM
from .market import Guidance, RetryPlan, run_job
from .orchestrator import TaskSpec
from .reputation import ReputationStore
from .estimate import estimate_session
from .sessions import SessionStore, usage_summary, vendor_stats


logger = logging.getLogger(__name__)
app = FastAPI()
# The market runs on this computer only. Checking the Host header stops DNS
# rebinding (another site pointing its own name at 127.0.0.1 to read /api/*).
# "testserver" is Starlette's TestClient.
LOCAL_HOSTS = ("localhost", "127.0.0.1", "::1", "[::1]")
app.add_middleware(TrustedHostMiddleware, allowed_hosts=[*LOCAL_HOSTS, "testserver"])


def _local_origin(origin: str | None) -> bool:
    """A browser page on this computer, or no Origin at all (a script, the terminal chat)."""
    return not origin or urlparse(origin).hostname in LOCAL_HOSTS
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
        # Sessions waiting their turn (start_job with queue: true while busy), oldest first.
        self.queue: list[dict] = []
        self._queue_seq = 0
        self.dropped: list[dict] = []  # queued sessions that couldn't start (limit reached, ...)

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
        retry: tuple[str, RetryPlan] | None = None,
    ) -> None:
        self.backlog = []
        self.guidance = Guidance()
        context, names = attachments.context_for(attachment_ids or [])
        sessions.expect(job, provider, budget_usd, names, tool_servers, attachment_ids)
        plan = None
        if retry is not None:
            source_id, plan = retry
            sessions.expect_retry(source_id)
        self.running = asyncio.create_task(
            self._run(
                job, price_weight, self.guidance, llm_for(provider),
                limits.job_budget(budget_usd),  # the spending limits cap this job too
                context, names, tool_servers, plan,
            )
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
        retry: RetryPlan | None = None,
    ) -> None:
        # Which MCP servers the vendors may use this session (None: all of them).
        tools.ALLOWED.set(frozenset(tool_servers) if tool_servers is not None else None)
        # A crashed job must tell everyone instead of leaving them waiting forever.
        try:
            await run_job(
                job, stream=self.stream, llm=job_llm or llm, rep=reputation, price_weight=price_weight,
                guidance=guidance, budget_usd=budget_usd, context=context or None, context_names=context_names or None,
                retry=retry,
            )
        except Exception as exc:
            logger.exception("job crashed")
            with contextlib.suppress(Exception):
                await self.stream.emit(
                    "error", {"message": f"internal error: {exc}", "task_id": None, "fatal": True}, job_id=None
                )
        except asyncio.CancelledError:
            # Stop didn't finish in time (a hung call): tell everyone it ended.
            with contextlib.suppress(Exception):
                await self.stream.emit(
                    "error", {"message": "stopped by you", "task_id": None, "fatal": True}, job_id=None
                )
            sessions.mark_stopped(self.stream.job_id)
        finally:
            if self.tools_changed:  # the Tools panel changed mcp.json mid-session
                self.tools_changed = False
                with contextlib.suppress(Exception):
                    await tools.shared().reload()
            self._start_next()

    # ------------------------------------------------------------- stop and queue
    def stop(self) -> None:
        """Stop the running job: no new AI calls; it wraps up with what it has.
        If it hasn't ended within STOP_GRACE_SECONDS, cancel it outright."""
        if not self.busy or self.guidance is None:
            return
        self.guidance.stop()
        running = self.running

        async def cancel_if_stuck() -> None:
            await asyncio.sleep(STOP_GRACE_SECONDS)
            if running is not None and not running.done():
                running.cancel()

        asyncio.get_running_loop().create_task(cancel_if_stuck())

    def enqueue(self, message: dict, retry: dict | None = None) -> dict:
        self._queue_seq += 1
        item = {
            "retry": retry,  # {session_id, task_ids} for a queued retry
            "id": f"q{self._queue_seq}",
            "job": message["job"],
            "price_weight": message.get("price_weight", config.PRICE_WEIGHT),
            "provider": message.get("provider"),
            "budget_usd": message.get("budget_usd"),
            "attachments": message.get("attachments"),
            "tools": message.get("tools"),
            "queued_at": time.time(),
        }
        self.queue.append(item)
        return item

    def dequeue(self, item_id: str) -> bool:
        before = len(self.queue)
        self.queue = [item for item in self.queue if item["id"] != item_id]
        return len(self.queue) != before

    def _start_next(self) -> None:
        """Start the oldest queued session that can still run."""
        while self.queue:
            item = self.queue.pop(0)
            if item.get("retry"):
                start, error = _retry_start({"type": "retry_task", **item["retry"]})
                error = error or limits.status()["message"]
                if error is None:
                    self.start(**start)
                    return
                logger.warning("dropped queued retry %s: %s", item["id"], error)
                self.dropped.append({"id": item["id"], "job": item["job"], "reason": error, "t": time.time()})
                del self.dropped[:-10]
                continue
            error = _validate_start({"type": "start_job", **item}) or limits.status()["message"]
            if error is not None:
                logger.warning("dropped queued session %s: %s", item["id"], error)
                self.dropped.append({"id": item["id"], "job": item["job"], "reason": error, "t": time.time()})
                del self.dropped[:-10]
                continue
            self.start(item["job"], item["price_weight"], item["provider"], item["budget_usd"], item["attachments"], item["tools"])
            return


STOP_GRACE_SECONDS = 30.0  # after Stop, how long a job may take to wrap up before it's cancelled
MAX_QUEUE = 10
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
    _local_only(request)  # otherwise any website could make this computer fetch links
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
def _same_machine(request: Request) -> None:
    """Only this computer's pages (by Origin) may change things."""
    if not _local_origin(request.headers.get("origin")):
        raise HTTPException(403, "only this computer can change this")


def _local_only(request: Request) -> None:
    """Changes that start programs or fetch links: JSON only (no cross-site
    form posts, which skip the browser's preflight) and a localhost Origin."""
    if not request.headers.get("content-type", "").startswith("application/json"):
        raise HTTPException(415, "send JSON")
    if not _local_origin(request.headers.get("origin")):
        raise HTTPException(403, "this can only be changed from this computer")


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


# ------------------------------------------------------------------ queue
@app.get("/api/queue")
async def api_queue() -> dict:
    """The running session (if any), the sessions waiting behind it, and any that couldn't start."""
    return {
        "running": market.busy,
        "stopping": bool(market.busy and market.guidance is not None and market.guidance.stopped),
        "queue": [{"id": i["id"], "job": i["job"], "provider": i["provider"], "queued_at": i["queued_at"]} for i in market.queue],
        "dropped": market.dropped,
    }


@app.delete("/api/queue/{item_id}")
async def api_dequeue(item_id: str, request: Request) -> dict:
    _same_machine(request)
    if not market.dequeue(item_id):
        raise HTTPException(404, "that session isn't in the queue")
    return await api_queue()


# ------------------------------------------------------------------ spending limits
@app.get("/api/limits")
async def api_limits() -> dict:
    """Spend today / this week / this month against the limits."""
    return limits.status()


@app.post("/api/limits")
async def api_set_limits(request: Request) -> dict:
    """Set limits: {day?, week?, month?} in dollars, null to clear."""
    body = await _json_body(request)
    try:
        limits.save(body)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    return limits.status()


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
    _same_machine(request)
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
    # Browsers let any site open a WebSocket to localhost, so check who's asking:
    # otherwise a page in another tab could watch jobs, start them on your key and use your tools.
    if not _local_origin(ws.headers.get("origin")):
        await ws.close(code=1008)
        return
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
                if market.busy and message.get("queue") is True:
                    # Wait for the current session instead of being refused.
                    error = _validate_start(message)
                    if error is None and len(market.queue) >= MAX_QUEUE:
                        error = f"the queue is full ({MAX_QUEUE} sessions)"
                    if error is not None:
                        await market.reply_error(ws, error)
                    else:
                        market.enqueue(message)
                    continue
                error = "a job is already running" if market.busy else _validate_start(message)
                if error is None:
                    error = limits.status()["message"]  # a spending limit is used up
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
            elif message_type == "retry_task":
                start, error = _retry_start(message)
                if error is None and market.busy:
                    if message.get("queue") is not True:
                        error = "a job is already running"
                    elif len(market.queue) >= MAX_QUEUE:
                        error = f"the queue is full ({MAX_QUEUE} sessions)"
                    else:
                        market.enqueue({"job": start["job"]}, retry={
                            "session_id": message["session_id"], "task_ids": message["task_ids"],
                            **({"budget_usd": message["budget_usd"]} if "budget_usd" in message else {}),
                        })
                        continue
                if error is None:
                    error = limits.status()["message"]
                if error is not None:
                    await market.reply_error(ws, error)
                    continue
                market.start(**start)
            elif message_type == "stop_job":
                if not market.busy:
                    await market.reply_error(ws, "no job is running to stop")
                    continue
                market.stop()
                await market.stream.emit("steered", {"target": "job", "note": "Stop: finish up, no new AI calls."})
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


def _retry_start(message: dict) -> tuple[dict | None, str | None]:
    """A retry_task message -> keyword arguments for Market.start, or an error.

    {session_id, task_ids: ["t2", ...], budget_usd?}. The job reuses the
    session's job text, AI, tools and files; only the named tasks go out for
    bids again, and the rest of its work is kept.
    """
    session_id, task_ids = message.get("session_id"), message.get("task_ids")
    if not isinstance(session_id, str):
        return None, "retry needs a session_id"
    if not isinstance(task_ids, list) or not task_ids or not all(isinstance(t, str) for t in task_ids):
        return None, "retry needs task_ids, like [\"t2\"]"
    record = sessions.get(session_id)
    if record is None:
        return None, "that session isn't saved here"
    plan = record.get("plan") or []
    if not plan:
        return None, "that session was saved before retries existed: use /rerun to run the whole job again"
    known = {t["task_id"] for t in plan}
    unknown = [t for t in task_ids if t not in known]
    if unknown:
        return None, f"no task {', '.join(unknown)} in that session (it has {', '.join(sorted(known))})"
    budget = message.get("budget_usd", record.get("budget_usd"))
    if budget is not None and (isinstance(budget, bool) or not isinstance(budget, (int, float)) or not 0 < budget <= 100):
        return None, "budget_usd must be more than $0 and at most $100"
    provider = record.get("provider")
    if provider not in config.available_providers():
        provider = None  # its AI has no key any more: use the default
    ids = [i for i in (record.get("attachment_ids") or []) if attachments.load(i) is not None]
    retry = RetryPlan(
        plan=[TaskSpec(**{k: t[k] for k in ("task_id", "type", "title", "brief", "depends_on")}) for t in plan],
        outputs=dict(record.get("outputs") or {}),
        redo=list(dict.fromkeys(task_ids)),
        kept={t["task_id"]: t for t in ((record.get("final") or {}).get("tasks") or [])},
    )
    return {
        "job": record.get("job_text") or "",
        "price_weight": config.PRICE_WEIGHT,
        "provider": provider,
        "budget_usd": budget,
        "attachment_ids": ids,
        "tool_servers": record.get("tools"),
        "retry": (session_id, retry),
    }, None


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
    if "queue" in message and not isinstance(message["queue"], bool):
        return "queue must be true or false"
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
