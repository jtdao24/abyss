"""Talk to the market's main agent from a terminal.

    python -m abyss.chat [--url ws://localhost:8000/ws] [--downloads ~/Downloads]

Type a job and press enter. Progress streams in as the vendors work; when the
job is done the main agent's file is saved to your Downloads folder.

Commands:
  /steer <1|2|3|job> <note>   steer one vendor, or the whole job, mid-run
  /price <0-5>                how much price matters when picking a vendor
  /reset                      reset every vendor's reputation
  /status                     what's running
  /help                       this list
  /quit                       leave (Ctrl-D works too)
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

import websockets

# The market never says which model runs a stall.
VENDOR = {"opus": "Vendor 1", "sonnet": "Vendor 2", "haiku": "Vendor 3"}
STEER_ALIASES = {
    "1": "opus", "v1": "opus", "vendor1": "opus",
    "2": "sonnet", "v2": "sonnet", "vendor2": "sonnet",
    "3": "haiku", "v3": "haiku", "vendor3": "haiku",
    "job": "job", "all": "job", "everyone": "job",
}
PROMPT = "you › "

_color = sys.stdout.isatty() and "NO_COLOR" not in os.environ


def paint(text: str, code: str) -> str:
    return f"\033[{code}m{text}\033[0m" if _color else text


def dim(t: str) -> str: return paint(t, "2")
def bold(t: str) -> str: return paint(t, "1")
def green(t: str) -> str: return paint(t, "32")
def yellow(t: str) -> str: return paint(t, "33")
def red(t: str) -> str: return paint(t, "31")
def cyan(t: str) -> str: return paint(t, "36")


@dataclass
class ChatState:
    price_weight: float = 1.0
    running: bool = False
    waiting_for_mine: bool = False   # sent start_job, job_split not seen yet
    my_job_id: str | None = None
    tasks: dict[str, dict] = field(default_factory=dict)


def downloads_dir(override: str | None = None) -> Path:
    return Path(override or os.environ.get("ABYSS_DOWNLOADS") or Path.home() / "Downloads").expanduser()


def save_deliverable(folder: Path, filename: str, content: str) -> Path:
    """Write the file without overwriting: solution.py, solution (1).py, ..."""
    folder.mkdir(parents=True, exist_ok=True)
    stem, dot, ext = filename.rpartition(".")
    if not dot:
        stem, ext = filename, ""
    path = folder / filename
    n = 1
    while path.exists():
        path = folder / (f"{stem} ({n}).{ext}" if ext else f"{stem} ({n})")
        n += 1
    path.write_text(content if content.endswith("\n") else content + "\n", encoding="utf-8")
    return path


def parse_command(line: str) -> tuple[str, dict]:
    """('job'|'steer'|'price'|'reset'|'status'|'help'|'quit'|'empty'|'invalid', details)."""
    text = line.strip()
    if not text:
        return "empty", {}
    if not text.startswith("/"):
        return "job", {"job": text}
    head, _, rest = text.partition(" ")
    command = head[1:].lower()
    if command in ("quit", "exit", "q"):
        return "quit", {}
    if command in ("help", "h", "?"):
        return "help", {}
    if command == "status":
        return "status", {}
    if command == "reset":
        return "reset", {}
    if command == "price":
        try:
            weight = float(rest)
        except ValueError:
            return "invalid", {"why": "usage: /price <number between 0 and 5>"}
        if not 0 <= weight <= 5:
            return "invalid", {"why": "price weight must be between 0 and 5"}
        return "price", {"price_weight": weight}
    if command == "steer":
        who, _, note = rest.strip().partition(" ")
        target = STEER_ALIASES.get(who.lower())
        if target is None or not note.strip():
            return "invalid", {"why": "usage: /steer <1|2|3|job> <note>"}
        return "steer", {"target": target, "note": note.strip()}
    return "invalid", {"why": f"unknown command /{command} (try /help)"}


def describe(event: dict, state: ChatState) -> str | None:
    """One readable line (or a few) for an event, or None to stay quiet."""
    kind, d = event["type"], event["data"]
    if kind == "hello":
        cfg = d["config"]
        mode = "FAKE MODE — no real AI calls" if cfg["fake_llm"] else (
            "TEST MODE — every agent runs on Haiku" if not cfg["real_models"] else "LIVE — real models")
        return dim(f"connected to the market · {mode}")
    if kind == "job_split":
        state.tasks = {t["task_id"]: t for t in d["tasks"]}
        lines = [bold(f"🧭 Main agent split the job into {len(d['tasks'])} tasks:")]
        lines += [f"   {t['task_id'].upper()} {t['type']:<8} {t['title']}" for t in d["tasks"]]
        return "\n".join(lines)
    if kind == "task_posted":
        return cyan(f"\n→ {d['task_id'].upper()} ({d['type']}): vendors are walking to the boat to bid")
    if kind == "bid":
        who = VENDOR[d["agent_id"]]
        if not d["ok"]:
            return dim(f"   {who} passed")
        cents = (d["predicted_cost_usd"] or 0) * 100
        return dim(f"   {who} bids: promises {d['promised_quality']}/10 for {cents:.2f}¢ — \"{d['pitch']}\"")
    if kind == "won":
        return f"   ✓ {bold(VENDOR[d['agent_id']])} wins {d['task_id'].upper()}"
    if kind == "working":
        return dim(f"   {VENDOR[d['agent_id']]} is working on it...")
    if kind == "done":
        u = d["usage"]
        return dim(f"   {VENDOR[d['agent_id']]} finished ({u['output_tokens']} tokens, ${u['cost_usd']:.4f}) → off to the reviewer")
    if kind == "graded":
        grade, promised = d["grade"], d["promised_quality"]
        mark = green if promised is None or grade >= promised else (red if grade < promised - 1 else yellow)
        promise = f" (promised {promised})" if promised is not None else ""
        return f"   Reviewer: {mark(f'{grade}/10')}{promise} — {d['rationale']}"
    if kind == "rep_update":
        delta = d["new"] - d["old"]
        arrow = green("▲") if delta > 0 else red("▼") if delta < 0 else "="
        return dim(f"   {VENDOR[d['agent_id']]} {d['task_type']} reputation {d['old']:.3f} → {d['new']:.3f} ") + arrow
    if kind == "steered":
        who = "every vendor" if d["target"] == "job" else VENDOR[d["target"]]
        return yellow(f"   ✎ noted for {who}: \"{d['note']}\" (applies from their next piece of work)")
    if kind == "assembled":
        return bold(f"\n📦 Main agent is packaging everything into {d['filename']}")
    if kind == "error":
        return red(f"   ⚠ {d['message']}")
    return None


def print_line(text: str) -> None:
    # clear the prompt line, print, and put the prompt back
    sys.stdout.write(("\r\033[K" if _color else "") + text + "\n")
    if _color:
        sys.stdout.write(PROMPT)
    sys.stdout.flush()


def finish(event: dict, state: ChatState, folder: Path) -> str:
    d = event["data"]
    mine = event["job_id"] == state.my_job_id
    state.running = False
    if not mine:
        return dim("(another window's job finished)")
    state.my_job_id = None
    if not d["deliverable"] or not d["filename"]:
        return red(f"\n✗ The job ended ({d['status']}) without a file. Nothing was saved.")
    path = save_deliverable(folder, d["filename"], d["deliverable"])
    shown = str(path).replace(str(Path.home()), "~", 1)
    grade = d["mean_grade"] if d["mean_grade"] is not None else "—"
    lines = [
        green(bold(f"\n✅ Done! Your file is ready: {shown}")),
        f"   {d['summary']}" if d.get("summary") else None,
        dim(f"   mean grade {grade}/10 · total cost ${d['total_cost_usd']:.4f} · {d['duration_ms'] / 1000:.1f}s"
            + ("" if d["status"] == "ok" else f" · status {d['status']}")),
    ]
    return "\n".join(line for line in lines if line)


async def receive(ws, state: ChatState, folder: Path) -> None:
    async for raw in ws:
        event = json.loads(raw)
        if event["type"] == "job_split" and state.waiting_for_mine:
            state.my_job_id, state.waiting_for_mine = event["job_id"], False
            state.running = True
        elif event["type"] == "job_split":
            state.running = True
        if event["type"] == "error" and event["job_id"] is None and state.waiting_for_mine:
            state.waiting_for_mine = False  # our start_job was refused
        if event["type"] == "error" and event["data"]["fatal"]:
            state.running = state.waiting_for_mine = False
        text = finish(event, state, folder) if event["type"] == "final" else describe(event, state)
        if text:
            print_line(text)


async def chat(url: str, folder: Path, price_weight: float) -> int:
    state = ChatState(price_weight=price_weight)
    try:
        ws = await websockets.connect(url)
    except OSError as exc:
        print(red(f"Can't reach the market at {url} ({exc}). Is the backend running?"))
        return 1
    print(bold("Abyss — tell the main agent what you need.") + dim("  (/help for commands)"))
    print(dim(f"Finished files are saved to {str(folder).replace(str(Path.home()), '~', 1)}"))
    listener = asyncio.create_task(receive(ws, state, folder))
    try:
        while True:
            try:
                line = await asyncio.to_thread(input, PROMPT)
            except EOFError:
                # piped input ran out: let a job we started finish, then leave
                while state.waiting_for_mine or state.my_job_id:
                    await asyncio.sleep(0.2)
                return 0
            action, details = parse_command(line)
            if action == "quit":
                return 0
            if action == "empty":
                continue
            if action == "help":
                print(__doc__.split("Commands:", 1)[1].rstrip())
            elif action == "invalid":
                print(red(details["why"]))
            elif action == "status":
                print(dim("a job is running" if state.running or state.waiting_for_mine else "the market is idle")
                      + dim(f" · price weight {state.price_weight}"))
            elif action == "price":
                state.price_weight = details["price_weight"]
                print(dim(f"price weight set to {state.price_weight} for your next job"))
            elif action == "reset":
                await ws.send(json.dumps({"type": "reset"}))
                print(dim("reputations reset"))
            elif action == "steer":
                await ws.send(json.dumps({"type": "steer", **details}))
            elif action == "job":
                if state.running or state.waiting_for_mine:
                    print(yellow("A job is already running. Steer it with /steer, or wait for it to finish."))
                    continue
                state.waiting_for_mine = True
                await ws.send(json.dumps({"type": "start_job", "job": details["job"], "price_weight": state.price_weight}))
                print(dim("Sent to the main agent. Watch the market in your browser, or follow along here."))
    finally:
        listener.cancel()
        await ws.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Talk to the Abyss market from a terminal")
    parser.add_argument("--url", default=os.environ.get("ABYSS_WS_URL", "ws://localhost:8000/ws"))
    parser.add_argument("--downloads", help="where finished files go (default ~/Downloads)")
    parser.add_argument("--price-weight", type=float, default=1.0)
    args = parser.parse_args(argv)
    try:
        return asyncio.run(chat(args.url, downloads_dir(args.downloads), args.price_weight))
    except KeyboardInterrupt:
        print()
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
