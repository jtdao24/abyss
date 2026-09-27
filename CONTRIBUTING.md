# Contributing to Abyss

Thanks for helping out. Abyss is a small project, so the process is light: open an issue for anything big, then send a pull request.

## Set up

You need Python 3.11+ and Node.js 20+.

```bash
python start.py --setup
```

This asks for API keys, creates `backend/.venv`, installs the npm packages, then starts the market. Press Ctrl-C to stop it.

Or by hand:

```bash
cd backend
python -m venv .venv
.venv/bin/pip install -e ".[dev]"          # Windows: .venv\Scripts\pip install -e ".[dev]"
cd ../web
npm install
```

## Develop without spending money

Run the backend in fake mode: no AI calls, canned outputs, synthetic token counts.

```bash
cd backend
ABYSS_FAKE_LLM=1 .venv/bin/uvicorn abyss.server:app --port 8000 --reload
# Windows (PowerShell): $env:ABYSS_FAKE_LLM="1"; .venv\Scripts\uvicorn abyss.server:app --port 8000 --reload
```

Then run the hot-reloading market view in a second terminal. It proxies `/api` and `/ws` to port 8000.

```bash
cd web
npm run dev                 # http://localhost:5173
```

When you need real calls, use `python start.py --test`: every vendor runs on the budget model. Real models are the default, so be deliberate about cost.

To work on the scene without any backend, open `http://localhost:5173/?source=fixture&file=fake_run` to replay the recorded run.

## Tests

Tests never touch the network or your keys. `backend/tests/conftest.py` forces fake mode and keeps real keys, MCP servers and spend limits out.

```bash
cd backend && .venv/bin/pytest -q
cd web && npm test && npm run build
```

CI runs all three on every pull request. Please make sure they pass locally first.

## Ground rules

- **The event contract is [SPEC.md](SPEC.md).** If you change an event or a client message, do it in one commit that touches:
  - `backend/abyss/contract.py`,
  - `web/src/contract.ts`,
  - `fixtures/make_fake_run.py`, then re-run `python fixtures/make_fake_run.py` (never hand-edit `fake_run.json`),
  - and a line in SPEC §10.

  Additive changes stay `v: 1`. Breaking ones need a version bump and an issue first.
- **Only `backend/abyss/llm.py` calls a model.** It writes a ledger entry for every call, including failed ones. New features go through it so costs stay honest.
- **Keep it boring.** Async on the request path, no database or agent framework, no new dependencies without a reason in the PR.
- **Frontend:** TypeScript, React 18, pixi.js v8 driven imperatively (no `@pixi/react`). The scene should stay correct even if animations are skipped.
- **Secrets never go in the repo.** Keys live in `backend/.env`; `mcp.json` holds `${VAR}` references only. Both are gitignored.

## Pull requests

1. Branch from `main`, for example `feature/replay-list` or `fix/ws-reconnect`.
2. Keep each PR to one change, and add or update tests for it.
3. In the description, say what changed and how you checked it. Add a screenshot or GIF for anything visual.

[docs/TASKS.md](docs/TASKS.md) is the original build plan. It's kept for history and isn't a to-do list.

By contributing, you agree that your work is released under the [MIT License](LICENSE).
