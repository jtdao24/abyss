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
| Vendor 3 (budget) | GPT-6 Luna | Muse Spark 1.3 |
| Vendor 2 (standard) | GPT-6 Sol | Muse Spark 1.3 |
| Vendor 1 (premium) | GPT-6 Astra | Muse Spark 1.3 |
| Main agent, reviewer | GPT-6 Sol | Muse Spark 1.3 |

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

## The Captain

Click the Main Agent on the boat to open the Captain terminal. Type a job and press Enter, or use a command (`/help` lists them all):

| command | |
|---|---|
| *any text* | give the main agent a job (while one runs, it waits in the queue) |
| `/steer <1\|2\|3\|job> <note>` | steer one vendor, or the whole job, mid-run |
| `/stop` (or the red **stop** button) | stop the running job: work in hand finishes, no new AI calls start |
| `/queue`, `/unqueue <n>` | list queued jobs, remove one |
| `/sessions`, `/open <n>`, `/rerun [n]` | past sessions; run one again with the same job, AI, budget, tools and files |
| `/price <0-5>` | how much price matters when choosing a vendor (0 = quality only) |
| `/budget <usd\|off>` | hard spending cap for your next job |
| `/ai [name]` | pick the AI for your next job |
| `/link <url>`, `/file` | attach a link or a file to your next job |
| `/tools [on\|off <name>\|all]` | which tool servers the vendors may use |
| `/examples`, `/example <n>` | sample jobs |
| `/estimate` | what a typical job costs |
| `/result`, `/save` | read or download the finished file |
| `/status`, `/reset`, `/clear`, `/exit` | what's running; reset every vendor's reputation; clear; close |

There's also a plain terminal chat (`python start.py --chat`) with `/steer`, `/price`, `/reset` and `/status`. It shares the same market as the browser.

The market shows vendor names, not models. The table above says which model runs each stall, and the ledger shows the exact model of every call.

## Spending

- **Per job:** `/budget` sets a hard cap. The crew stops starting AI calls when it runs out.
- **Per day, week and month:** click the spend meter in the bottom-right corner to set limits. At 80% the page warns you; at 100% new sessions are refused and a running one is capped to what's left.
- **Right now:** `/stop` ends the running job.
- **Costs:** the **Costs** button in the header shows what each session cost and what the premium vendor alone would have cost.

The speaker button in the header turns the 8-bit sound effects on or off (remembered per browser).

## How the market works

```
score = promised_quality × reputation − price_weight × predicted_cost_in_cents
reputation ← reputation + 0.3 × (grade / promised_quality − reputation)
```

A vendor that promises 9 and delivers 6 ends up with a reputation below 1.0, so its future promises are worth less. The premium vendor is a backup: it only bids on a task type once the cheaper vendors' reputation there drops below 0.9, or when all their bids fail (or at price weight 0). Reputation is tracked per vendor and per task type, and it persists in `runs/reputation.json`. [SPEC.md](SPEC.md) is the full contract: auction, failure policy, the event stream and the ledger format.

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
- `?ledger=1` opens the raw call ledger instead of the cost dashboard
- `?calm=1` turns off the rippling water and swaying leaves (for slow machines)

Frontend tests: `cd web && npm test`. GitHub Actions runs the backend tests, the frontend tests and the web build on every pull request.

## Project layout

```
backend/abyss/   FastAPI + WebSocket server, market loop, LLM gateway (the only module that calls a model), ledger
web/src/         React + PixiJS v8 market view
fixtures/        canonical recorded run used by tests and replay
experiments/     experiment jobs and results
runs/            your local ledger, reputation, sessions, limits, logs (gitignored)
.github/         CI workflow
```

## License

[MIT](LICENSE)
