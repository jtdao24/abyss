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

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from . import config
from .contract import validate_event
from .events import EventStream, hello_data
from .llm import LLM
from .market import Guidance, run_job
from .reputation import ReputationStore


logger = logging.getLogger(__name__)
app = FastAPI()
reputation = ReputationStore(config.rep_path())
llm = LLM()

STEER_TARGETS = {"job", *(agent.agent_id for agent in config.AGENTS)}


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

    def start(self, job: str, price_weight: float) -> None:
        self.backlog = []
        self.guidance = Guidance()
        self.running = asyncio.create_task(self._run(job, price_weight, self.guidance))

    async def _run(self, job: str, price_weight: float, guidance: Guidance) -> None:
        # A crashed job must tell everyone instead of leaving them waiting forever.
        try:
            await run_job(job, stream=self.stream, llm=llm, rep=reputation, price_weight=price_weight, guidance=guidance)
        except Exception as exc:
            logger.exception("job crashed")
            with contextlib.suppress(Exception):
                await self.stream.emit(
                    "error", {"message": f"internal error: {exc}", "task_id": None, "fatal": True}, job_id=None
                )


market = Market()


@app.get("/health")
async def health() -> dict[str, bool]:
    return {"ok": True}


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
                market.start(message["job"], message.get("price_weight", config.PRICE_WEIGHT))
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
    return None
