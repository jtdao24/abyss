"""Start Abyss: the sea market runs on this machine and opens in your browser.

    python start.py            start: real AI, each vendor on its own model (asks for keys the first time)
    python start.py --test     cheaper: every vendor runs on the budget model
    python start.py --setup    add or change API keys (OpenAI, Meta Muse Spark)

Every run makes real AI calls, so an OpenAI or Meta key is required.

Options:
    --port N        port for the market (default 8000)
    --dev           run the Vite dev server too (hot reload, on --web-port)
    --web-port N    dev server port (default 5173)
    --chat          also run the terminal chat in this window
    --no-browser    don't open the browser

The first run sets everything up (Python venv, npm packages, a build of the
market view). Keys are saved to backend/.env (gitignored). Server logs go to
runs/logs/. Works on Windows, macOS and Linux; uses only the standard library.
"""
from __future__ import annotations

import argparse
import getpass
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BACKEND = ROOT / "backend"
WEB = ROOT / "web"
VENV = BACKEND / ".venv"
LOGS = ROOT / "runs" / "logs"
WINDOWS = os.name == "nt"
KEYS_FILE = BACKEND / ".env"
DOTENV_FILES = (ROOT / ".env", KEYS_FILE)
# Which env var holds each provider's key, and what we call it.
PROVIDER_KEYS = {"openai": "OPENAI_API_KEY", "meta": "MODEL_API_KEY"}
PROVIDER_NAMES = {"openai": "OpenAI", "meta": "Meta Muse Spark"}


def say(msg: str) -> None:
    print(f"[abyss] {msg}", flush=True)


def fail(msg: str) -> None:
    print(f"[abyss] error: {msg}", file=sys.stderr, flush=True)
    raise SystemExit(1)


# ---------------------------------------------------------------- checks

def venv_python() -> Path:
    return VENV / ("Scripts/python.exe" if WINDOWS else "bin/python")


def load_dotenv() -> None:
    """Read KEY=VALUE lines from .env (repo root, then backend/). Real env vars win."""
    for path in DOTENV_FILES:
        if not path.exists():
            continue
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.removeprefix("export ").strip()
            value = value.strip().strip('"').strip("'")
            if value:
                os.environ.setdefault(key, value)


def ensure_python_env() -> Path:
    py = venv_python()
    if not py.exists():
        say(f"First run: creating a Python venv in {VENV.relative_to(ROOT)} ...")
        subprocess.run([sys.executable, "-m", "venv", str(VENV)], check=True)
    probe = subprocess.run(
        [str(py), "-c", "import abyss, uvicorn, fastapi, openai, websockets"],
        cwd=BACKEND, capture_output=True,
    )
    if probe.returncode != 0:
        say("Installing backend packages (one time) ...")
        result = subprocess.run([str(py), "-m", "pip", "install", "-q", "-e", ".[dev]"], cwd=BACKEND)
        if result.returncode != 0:
            fail("pip install failed. Try it yourself: cd backend && .venv python -m pip install -e .[dev]")
    return py


def ensure_web_env() -> str:
    npm = shutil.which("npm")
    if npm is None:
        fail("Node.js (with npm) is needed for the market view. Install Node 20+ from https://nodejs.org")
    if not (WEB / "node_modules").exists():
        say("Installing web packages (one time) ...")
        if subprocess.run([npm, "install"], cwd=WEB).returncode != 0:
            fail("npm install failed. Try it yourself: cd web && npm install")
    return npm


def _newest_source_mtime() -> float:
    newest = 0.0
    skip = {WEB / "public" / "fixtures", WEB / "public" / "results"}  # rewritten by every build
    for base in (WEB / "src", WEB / "public"):
        for path in base.rglob("*"):
            if path.is_file() and not any(parent in skip for parent in path.parents):
                newest = max(newest, path.stat().st_mtime)
    for name in ("index.html", "package.json", "vite.config.ts"):
        if (WEB / name).exists():
            newest = max(newest, (WEB / name).stat().st_mtime)
    return newest


def ensure_web_build(npm: str) -> None:
    """Build the market view when it's missing or older than its sources."""
    index = WEB / "dist" / "index.html"
    if index.exists() and index.stat().st_mtime >= _newest_source_mtime():
        return
    say("Building the market view ..." if index.exists() else "First run: building the market view ...")
    LOGS.mkdir(parents=True, exist_ok=True)
    with open(LOGS / "build.log", "w", encoding="utf-8") as log:
        result = subprocess.run([npm, "run", "build"], cwd=WEB, stdout=log, stderr=subprocess.STDOUT)
    if result.returncode != 0:
        fail(f"the web build failed. Last lines of runs/logs/build.log:\n{tail('build.log')}")


def port_in_use(port: int) -> bool:
    # "localhost" can be IPv4 or IPv6 depending on the OS, so check both.
    for family, host in ((socket.AF_INET, "127.0.0.1"), (socket.AF_INET6, "::1")):
        try:
            with socket.socket(family, socket.SOCK_STREAM) as s:
                s.settimeout(0.3)
                if s.connect_ex((host, port)) == 0:
                    return True
        except OSError:
            pass
    return False


# ---------------------------------------------------------------- keys

def configured_providers() -> list[str]:
    return [name for name, var in PROVIDER_KEYS.items() if os.environ.get(var)]


def save_keys(updates: dict[str, str]) -> None:
    """Upsert KEY=VALUE lines in backend/.env, keeping every other line as is."""
    lines = KEYS_FILE.read_text(encoding="utf-8").splitlines() if KEYS_FILE.exists() else [
        "# Abyss settings and API keys. This file is gitignored: never commit it.",
    ]
    remaining = dict(updates)
    for i, line in enumerate(lines):
        key = line.split("=", 1)[0].strip() if "=" in line and not line.lstrip().startswith("#") else None
        if key in remaining:
            lines[i] = f"{key}={remaining.pop(key)}"
    lines.extend(f"{key}={value}" for key, value in remaining.items())
    KEYS_FILE.write_text("\n".join(lines) + "\n", encoding="utf-8")
    if not WINDOWS:
        KEYS_FILE.chmod(0o600)


def setup_wizard() -> None:
    """Ask for API keys (hidden input) and the default AI. Enter skips anything."""
    say("Setup: paste an API key and press Enter, or just press Enter to skip. Input is hidden.")
    updates: dict[str, str] = {}
    for name, url in (("openai", "https://platform.openai.com/api-keys"), ("meta", "https://dev.meta.ai")):
        var = PROVIDER_KEYS[name]
        have = " (one is saved; Enter keeps it)" if os.environ.get(var) else ""
        try:
            key = getpass.getpass(f"[abyss] {PROVIDER_NAMES[name]} key from {url}{have}: ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            key = ""
        if key:
            updates[var] = key
            os.environ[var] = key
    have = configured_providers()
    if len(have) > 1:
        options = ", ".join(f"{i + 1}) {PROVIDER_NAMES[p]}" for i, p in enumerate(have))
        try:
            pick = input(f"[abyss] Default AI for new sessions? {options} [1]: ").strip() or "1"
        except EOFError:
            pick = "1"
        chosen = have[int(pick) - 1] if pick.isdigit() and 1 <= int(pick) <= len(have) else have[0]
        updates["ABYSS_PROVIDER"] = chosen
        os.environ["ABYSS_PROVIDER"] = chosen
    if updates:
        save_keys(updates)
        saved = sorted(k for k in updates if k != "ABYSS_PROVIDER")
        say(f"Saved to {KEYS_FILE.relative_to(ROOT)}: {', '.join(saved) or 'default AI'} (keys never printed).")
    elif not have:
        say("No keys added.")


def require_key() -> None:
    """Every run makes real AI calls: stop early if there's no key to make them with."""
    if not configured_providers():
        fail(
            "Abyss needs an OpenAI or Meta Muse Spark API key.\n"
            "        Run `python start.py --setup` (or double-click start.cmd) and paste one in."
        )


def default_provider() -> str | None:
    """Keep ABYSS_PROVIDER if set; otherwise use the first provider with a key."""
    current = os.environ.get("ABYSS_PROVIDER")
    have = configured_providers()
    if current and (current in have or not have):
        return current
    return have[0] if have else current


# ---------------------------------------------------------------- processes

def spawn(cmd: list[str], cwd: Path, env: dict[str, str], log_name: str) -> subprocess.Popen:
    LOGS.mkdir(parents=True, exist_ok=True)
    log = open(LOGS / log_name, "w", encoding="utf-8")
    # Own process group, so Ctrl-C here doesn't hit the servers directly
    # and we can stop the whole tree (npm -> node) on the way out.
    extra: dict = (
        {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if WINDOWS else {"start_new_session": True}
    )
    return subprocess.Popen(cmd, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT, **extra)


def stop(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    if WINDOWS:
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], capture_output=True)
    else:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()


def up(url: str) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=1) as resp:
            return resp.status == 200
    except OSError:
        return False


def tail(log_name: str, lines: int = 15) -> str:
    path = LOGS / log_name
    if not path.exists():
        return ""
    return "\n".join(path.read_text(encoding="utf-8", errors="replace").splitlines()[-lines:])


def wait_until_up(procs: dict[str, subprocess.Popen], checks: dict[str, str]) -> None:
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        for log_name, proc in procs.items():
            if proc.poll() is not None:
                fail(f"{log_name.split('.')[0]} exited early. Last lines of runs/logs/{log_name}:\n{tail(log_name)}")
        if all(up(url) for url in checks.values()):
            return
        time.sleep(0.5)
    fail(f"the market didn't come up within 60s. Check runs/logs/: {', '.join(checks)}")


# ---------------------------------------------------------------- main

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Start the Abyss sea market")
    parser.add_argument("--test", "--haiku", dest="test", action="store_true",
                        help="cheaper: every vendor runs on the budget model")
    parser.add_argument("--live", dest="test", action="store_false", help=argparse.SUPPRESS)  # the default now
    parser.add_argument("--setup", action="store_true", help="add or change API keys")
    parser.add_argument("--port", type=int, default=8000, help="market port (default 8000)")
    parser.add_argument("--dev", action="store_true", help="also run the Vite dev server (hot reload)")
    parser.add_argument("--web-port", type=int, default=5173, help="dev server port (default 5173)")
    parser.add_argument("--chat", action="store_true", help="run the terminal chat in this window")
    parser.add_argument("--no-browser", action="store_true", help="don't open the browser")
    parser.add_argument("--yes", action="store_true", help=argparse.SUPPRESS)  # kept for old scripts
    args = parser.parse_args(argv)

    if sys.version_info < (3, 11):
        fail(f"Python 3.11+ is needed (this is {sys.version.split()[0]}). Get it from https://python.org")

    load_dotenv()
    market_url = f"http://localhost:{args.port}/"
    # Already running (a second double-click): just show it.
    if not args.setup and port_in_use(args.port) and up(f"http://127.0.0.1:{args.port}/health"):
        say(f"Abyss is already running: {market_url}")
        if not args.no_browser:
            webbrowser.open(market_url)
        return 0

    if args.setup or (sys.stdin.isatty() and not configured_providers()):
        setup_wizard()
    require_key()

    py = ensure_python_env()
    npm = ensure_web_env()
    if not args.dev:
        ensure_web_build(npm)
    ports = [("--port", args.port)] + ([("--web-port", args.web_port)] if args.dev else [])
    for flag, port in ports:
        if port_in_use(port):
            fail(f"port {port} is already in use by something else. Pick another with {flag}.")
    run_mode = "test" if args.test else "live"

    env = dict(os.environ)
    # Always real AI. Test mode only swaps every vendor onto the budget model.
    env.pop("ABYSS_FAKE_LLM", None)
    env["ABYSS_REAL_MODELS"] = "0" if args.test else "1"
    if provider := default_provider():
        env["ABYSS_PROVIDER"] = provider
    ws_url = f"ws://localhost:{args.port}/ws"
    env["ABYSS_WS_URL"] = ws_url  # the terminal chat
    if args.dev and args.port != 8000:
        env["VITE_WS_URL"] = ws_url  # the dev proxy targets :8000; point elsewhere explicitly

    ai = PROVIDER_NAMES.get(env.get("ABYSS_PROVIDER", ""), env.get("ABYSS_PROVIDER", "AI"))
    detail = "every vendor on the budget model" if args.test else "each vendor on its own model"
    say(f"Starting the market ({ai}, {detail}) ...")
    procs = {
        "backend.log": spawn(
            [str(py), "-m", "uvicorn", "abyss.server:app", "--port", str(args.port), "--log-level", "warning"],
            BACKEND, env, "backend.log",
        ),
    }
    checks = {"backend.log": f"http://127.0.0.1:{args.port}/health"}
    if args.dev:
        procs["web.log"] = spawn([npm, "run", "dev", "--", "--port", str(args.web_port), "--strictPort"], WEB, env, "web.log")
        checks["web.log"] = f"http://localhost:{args.web_port}/"
    try:
        wait_until_up(procs, checks)
        url = f"http://localhost:{args.web_port}/" if args.dev else market_url
        say(f"Market: {url}   (click the Main Agent on the boat to start a session)")
        if not args.no_browser:
            webbrowser.open(url)
        if args.chat:
            say("Terminal chat: type a job below. /help lists commands, /quit (or Ctrl-C) stops everything.\n")
            try:
                subprocess.run([str(py), "-m", "abyss.chat"], cwd=BACKEND, env=env)
            except KeyboardInterrupt:
                pass
        else:
            say("Running. Press Ctrl-C to stop.")
            while all(proc.poll() is None for proc in procs.values()):
                time.sleep(0.5)
            for log_name, proc in procs.items():
                if proc.poll() is not None:
                    say(f"{log_name.split('.')[0]} stopped. Last lines of runs/logs/{log_name}:\n{tail(log_name)}")
    except KeyboardInterrupt:
        pass
    finally:
        say("Stopping the market ...")
        for proc in procs.values():
            stop(proc)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
