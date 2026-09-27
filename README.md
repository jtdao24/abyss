# Abyss

A pixel-art seaside market where AI agents bid on work.

You give the **main agent** a job, such as "research X and write a 200-word brief". It splits the job into typed subtasks (`research`, `writing`, `checking`). For each task, three **vendors** bid a predicted cost and a promised quality. The best score wins and does the work. A **blind reviewer** then grades it. Each vendor's reputation moves toward what it actually delivered, so overpromisers get discounted over time. At the end, the main agent packages everything into a file and saves it to your Downloads folder.

Everything happens live in the browser: vendors pitch at their stalls, the winner walks off to work, and grades get stamped. Every token of every model call is recorded in a ledger, so you always know what a job cost.

It runs entirely on your own machine. Nothing is deployed, and there are no accounts.

## Quick start

You need **Python 3.11+** and **Node.js 20+**.

```bash
git clone <this repo> abyss
cd abyss
python start.py
```

On Windows, if `python` isn't found, use `py start.py`.

On Windows you can also just double-click `start.cmd`.

The first run asks for your API keys (hidden input, saved to `backend/.env`, which is gitignored), creates a Python venv, installs the npm packages and builds the market view. That takes a minute or two. After that, `start.py`:

1. starts the market on `localhost:8000`,
2. opens it in your browser, where you click the Main Agent on the boat to start a session,
3. keeps running until you press Ctrl-C. Server logs are in `runs/logs/`.

## AI and cost

Abyss runs on **OpenAI** or **Meta Muse Spark**. Every run makes real AI calls, so you need at least one key. Add or change keys any time with `python start.py --setup`. With both keys, you choose the AI for each session.

| vendor | OpenAI | Meta |
|---|---|---|
| Vendor 3 (budget) | GPT-5 mini | Muse Spark 1.3 |
| Vendor 2 (premium) | GPT-5 | Muse Spark 1.3 |
| Vendor 1 (premium) | GPT-5 | Muse Spark 1.3 |
| Main agent, reviewer | GPT-5 | Muse Spark 1.3 |

| command | what it does |
|---|---|
| `python start.py` | Each vendor runs on its own model (above). |
| `python start.py --test` | Cheaper: every vendor runs on the budget model. The auction still prices bids at each stall's own model, so the market behaves the same. |

Every call's tokens and cost are recorded in the ledger (`runs/ledger.jsonl`). Change a tier's model with `ABYSS_OPENAI_CHEAP` / `_MID` / `_TOP` (or `ABYSS_META_*`) in `backend/.env`.

Other flags: `--port` if 8000 is taken, `--no-browser`, `--chat` to also run the terminal chat, and `--dev` for the hot-reloading dev server.

## Tools (MCP)

Vendors can call MCP tools while they work: read web pages, search, drive a
browser, post to Slack, open GitHub issues, query a database, and so on.
Click **Tools** in the header to:

- add a server from the catalog in one click (Fetch, Playwright, Context7,
  Filesystem, Git, SQLite, Memory, Brave, Tavily, Exa, Firecrawl, GitHub,
  Slack, Discord, Notion, Airtable, Postgres, Supabase, HubSpot, Google Maps,
  Stripe, ...), or any other MCP server by command or URL;
- paste the keys a server needs. They are saved to `backend/.env` only;
  `mcp.json` (gitignored) keeps `${VAR}` references;
- see each server's status and tools, turn single tools off, and watch the
  vendors' recent tool calls.

When you start a session, the Captain lets you pick which servers the vendors
may use. Local servers need Node.js (`npx`) or uv (`uvx`). Tool rounds are
billed like any other call and count toward the budget cap.

## The chat

| command | |
|---|---|
| *any text* | give the main agent a job |
| `/steer <1\|2\|3\|job> <note>` | steer one vendor, or the whole job, mid-run |
| `/price <0-5>` | how much price matters when choosing a vendor (0 = quality only) |
| `/reset` | reset every vendor's reputation |
| `/status` | what's running |

Run it with `python start.py --chat`. The market shows vendor names, not models; the table above says which model runs each stall, and the ledger shows the exact model of every call.

## How the market works

```
score = promised_quality × reputation − price_weight × predicted_cost_in_cents
reputation ← reputation + 0.3 × (grade / promised_quality − reputation)
```

A vendor that promises 9 and delivers 6 ends up with a reputation below 1.0, so its future promises are worth less. Reputation is tracked per vendor and per task type, and it persists in `runs/reputation.json`. [SPEC.md](SPEC.md) is the full contract: auction, failure policy, the event stream and the ledger format.

## Other things you can run

From `backend/` with the venv active (`.venv\Scripts\activate` on Windows, `source .venv/bin/activate` elsewhere):

```bash
python -m abyss.cli "your job" --record ../runs/my_run.json   # headless run, save the events
python -m abyss.experiment --estimate                         # cost/quality experiment: estimate first
python -m abyss.experiment --arms market@1,fixed:opus         # then run it (real API calls)
pytest                                                        # backend tests (no network)
```

In the browser:

- `?source=fixture&file=fake_run&speed=2` replays a recording from `fixtures/` (no backend needed)
- `?view=results` shows experiment results from `experiments/results/`
- `?ledger=1` opens the ledger panel

Frontend tests: `cd web && npm test`.

## Project layout

```
backend/abyss/   FastAPI + WebSocket server, market loop, LLM gateway (the only module that calls a model), ledger
web/src/         React + PixiJS v8 market view
fixtures/        canonical recorded run used by tests and replay
experiments/     experiment jobs and results
runs/            your local ledger, reputation, logs (gitignored)
```

## License

[MIT](LICENSE)
