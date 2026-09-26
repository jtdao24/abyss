# Abyss — TASKS

The orchestrator (Claude) plans, specs and reviews. **Codex writes all feature code.**
Each task is one Codex session. Paste the whole task block into Codex together with `SPEC.md`.

## How to use this file

- **Two parallel tracks.** Backend (B) and frontend (F) own disjoint files, so run one Codex session per track at the same time.
- **Ownership is strict.** A task may only create or modify files listed under *Owns*. Touching anything else is an automatic review failure. Shared-file edits are listed explicitly.
- **Review.** I review each task when Codex reports done:
  1. Run the *Verify* commands.
  2. Check every acceptance box.
  3. Check the diff stays inside *Owns*.
  4. Grep for contract drift.
  5. Reply with a numbered list of required changes, or **ACCEPTED**.
- **Global constraints (apply to every task):**
  - Python 3.11, `async` everywhere on the request path. No database, LangChain, CrewAI or ORMs.
  - Only `backend/abyss/llm.py` may `import anthropic`.
  - Tests never hit the network. They use `ABYSS_FAKE_LLM=1` or pure functions.
  - Real API calls during development use Haiku test mode only (the default, SPEC §1.5). **Never set `ABYSS_REAL_MODELS=1` without orchestrator approval.**
  - Frontend is TypeScript, pixi.js **v8** and React 18. Don't use `@pixi/react`: Pixi is driven imperatively inside one `useEffect`.
  - Prefer boring code: no metaprogramming, no clever abstractions, no new dependencies beyond those named in the task.

## Status board

| # | Title | Track | Stage | Depends | Est | Status |
|---|---|---|---|---|---|---|
| T00 | SPEC, fixture, tasks | orch | 0 | — | 1h | ✅ done |
| T01 | Backend skeleton, config, pricing, ledger, contract validator | B | 1 | T00 | 1.5h | ⬜ |
| T02 | LLM gateway (real + fake), ledger-wired | B | 1 | T01 | 2h | ⬜ |
| T03 | Reputation store + scoring (pure) | B | 1 | T01 | 1h | ⬜ |
| T04 | Prompts: orchestrator, bid, work, review | B | 1 | T02, T03 | 2h | ⬜ |
| T05 | Market loop, event stream, headless CLI | B | 1 | T04 | 2.5h | ⬜ |
| T06 | FastAPI WebSocket server | B | 2 | T05 | 1.5h | ⬜ |
| T07 | Web skeleton, contract types, fixture source, reducer, debug UI | F | 3 | T00 | 2.5h | ⬜ |
| T08 | Static pixel scene | F | 3 | T07 | 4h | ⬜ |
| T09 | Animation director | F | 4 | T08 | 5h | ⬜ |
| T10 | Connect: WS source, job input, deliverable panel | F | 5 | T06, T07 | 2h | ⬜ |
| T11 | Cost/quality experiment runner | B | 6 | T05 | 3h | ⬜ |
| T12 | Experiment results view | F | 6 | T11, T07 | 2h | ⬜ |
| T13 | Polish pass | F/B | 7 | T10 | ≤4h | ⬜ |
| T14 | Freeze: README, demo recording, demo script | orch+B | 8 | all | 2h | ⬜ |

## Timeline and cut rules (36h, hours from kickoff)

| Hour | Backend track | Frontend track | Checkpoint (orchestrator) |
|---|---|---|---|
| 0–1 | T00 | T00 | Contract frozen ✅ |
| 1–5 | T01, T02 (T03 in between) | T07 | |
| 5–10 | T04, T05 | T08 | **H10: `abyss.cli` runs a real Haiku job end-to-end with a correct ledger.** If it doesn't, the frontend track pauses and helps the backend. |
| 10–12 | T06 | T08 finish | **H12: WS streams a fake-mode job, and the validator passes on a recording.** |
| 12–17 | T11 | T09 | |
| 17–20 | T11 real run (needs approval) | T10 | **H20: browser → WS → real Haiku job → scene updates.** If not: cut T09 down to bid bubbles, winner highlight and grade stamp only. |
| 20–24 | experiment analysis | T12 | **H24: experiment results JSON exists from real models.** If not, cut T13 entirely. |
| 24–30 | T13 (backend bits) | T13 | |
| 30–34 | T14 | T14 | **H30: feature freeze.** Bug fixes only after this. |
| 34–36 | buffer / sleep | buffer | Demo rehearsal x2 |

**Cut order when behind:** T13 polish → T09 animation (the scene is state-driven, so it stays correct with zero animations) → T08 visuals (the T07 debug UI is the fallback demo UI).
**Never cut:** auction (T03/T05), reputation (T03/T05), ledger (T01/T02), experiment (T11).

---

## T01 — Backend skeleton, config, pricing, ledger, contract validator
**Track** B · **Stage** 1 · **Depends** T00

**Owns:** `backend/pyproject.toml`, `backend/abyss/__init__.py`, `backend/abyss/config.py`, `backend/abyss/ledger.py`, `backend/abyss/contract.py`, `backend/tests/test_ledger.py`, `backend/tests/test_contract.py`, `backend/tests/conftest.py`

**Goal:** the pure foundations everything else imports, plus a validator that proves the fixture matches SPEC §7.

**Build:**
- `pyproject.toml`:
  - Deps: `anthropic` (latest; pin `>=` to the version pip installs), `fastapi`, `uvicorn[standard]`, `pydantic>=2`.
  - Extras `dev`: `pytest`, `pytest-asyncio`, `websockets`.
  - `requires-python = ">=3.11"`, package dir `abyss`.
- `config.py`:
  - Constants from SPEC §1: `AGENTS`, a list of frozen dataclasses `AgentSpec(agent_id, display_name, model, color)` in stall order.
  - `PRICES: dict[str, tuple[float, float]]`, `SUPPORTS_EFFORT: set[str]`, `TASK_TYPES`, all tunables, `ORCHESTRATOR_MODEL`, `REVIEWER_MODEL`.
  - Env readers:
    - `real_models() -> bool`
    - `fake_llm() -> bool`
    - `fake_delay() -> float`
    - `ledger_path() -> Path`
    - `rep_path() -> Path`
    - `resolve_model(nominal: str) -> str`: returns `claude-haiku-4-5` unless `real_models()`.
- `ledger.py`:
  - `def cost_usd(model: str, input_tokens: int, output_tokens: int, cache_read: int = 0, cache_write: int = 0) -> float`, rounded to 6 dp.
  - `@dataclass LedgerEntry`, with the fields from SPEC §5.
  - `class Ledger`:
    - `__init__(self, job_id: str, path: Path | None)`
    - `record(self, **fields) -> LedgerEntry`: assigns the `id`, appends in memory and appends a JSONL line to `path` if set.
    - `entries(self) -> list[LedgerEntry]`
    - `stats(self, tasks_won: dict[str, int]) -> dict`: exact SPEC §7.4 `stats` shape.
    - `task_cost(self, task_id: str) -> float`
    - `total_cost(self) -> float`
- `contract.py`:
  - Pydantic v2 models for the envelope and for each event's `data`, per SPEC §7.4, with `model_config = ConfigDict(extra="forbid")`. Optional-but-present fields are typed `X | None` **with no default**, so a missing key fails validation.
  - `def validate_event(ev: dict) -> None`: raises on any violation.
  - `def validate_stream(events: list[dict]) -> None`: also checks that `seq` is strictly increasing and that the per-job order rules in SPEC §7.2 hold (e.g. `won` comes after all `bid`s for that task, `final` is last).
  - `python -m abyss.contract <file.json>` prints `OK <n> events` or the first error and exits 1.

**Constraints:** no network, no `anthropic` import. `stats()` must emit all four purposes and all three agents even when they're zero.

**Acceptance:**
- [ ] `cd backend && python -m venv .venv && . .venv/bin/activate && pip install -e ".[dev]"` succeeds.
- [ ] `python -m abyss.contract ../fixtures/fake_run.json` → `OK 37 events`.
- [ ] `test_contract.py`:
  - The fixture passes.
  - Deleting any single `data` key from any fixture event fails.
  - Adding an unknown key fails.
  - Swapping `won` before a `bid` fails.
- [ ] `test_ledger.py`:
  - `cost_usd("claude-opus-5", 350, 180) == 0.00625`.
  - Re-computing the fixture's ledger (build entries from the fixture's `usage` blocks) through `Ledger.stats()` reproduces the fixture's final `stats` event exactly.
  - The JSONL file gets one line per `record`.
- [ ] `pytest -q` is green.

**Verify:** `cd backend && pytest -q && python -m abyss.contract ../fixtures/fake_run.json`

---

## T02 — LLM gateway (real + fake), ledger-wired
**Track** B · **Stage** 1 · **Depends** T01

**Owns:** `backend/abyss/llm.py`, `backend/tests/test_llm.py`

**Goal:** a single choke point for every model call, so ledger logging can't be forgotten.

**Build:**
```python
Purpose = Literal["split", "bid", "work", "review"]

@dataclass
class LLMResult:
    text: str                 # concatenated text blocks (thinking blocks skipped)
    data: dict | None         # parsed JSON when schema given
    usage: dict               # SPEC §7.3 Usage
    stop_reason: str | None

class LLMError(Exception): ...

class LLM:
    def __init__(self) -> None           # reads config.fake_llm(); creates AsyncAnthropic() lazily if real
    async def call(self, *, ledger: Ledger, purpose: Purpose, nominal_model: str,
                   system: str, user: str, max_tokens: int,
                   effort: str | None = None, schema: dict | None = None,
                   task_id: str | None = None, agent_id: str | None = None) -> LLMResult
```
- `model = config.resolve_model(nominal_model)`. Only pass `output_config={"effort": effort}` when `model in SUPPORTS_EFFORT`.
- Don't send `thinking`: Sonnet 5 and Opus 5 run adaptive by default, and Haiku runs without it.
- Don't send `temperature` (Sonnet 5 and Opus 5 reject sampling params).
- When `schema` is given, add `output_config["format"] = {"type": "json_schema", "schema": schema}`, then `json.loads` the first text block.
- **Every** path records exactly one ledger entry: success, API exception (0 tokens, `ok=False`, `error=str(e)`), refusal (`stop_reason == "refusal"`, tokens from usage, `ok=False`) and bad JSON (tokens recorded, `ok=False`). After recording a failure, raise `LLMError`.
- Usage comes from `resp.usage.input_tokens`, `output_tokens`, `cache_read_input_tokens or 0` and `cache_creation_input_tokens or 0`. Cost comes from `ledger.cost_usd` using the model **actually called**. `duration_ms` is wall clock.
- **Fake mode** (`ABYSS_FAKE_LLM=1`):
  - No network. `await asyncio.sleep(fake_delay())`.
  - Output is deterministic on `sha256(purpose + nominal_model + user)`:
    - `split` → 3 tasks (research → writing → checking, chained)
    - `bid` → tokens 150–700 and quality 6–10 derived from the hash, plus a short pitch
    - `work` → a paragraph that mentions the task brief's first 8 words
    - `review` → grade 5–10
  - Usage is synthetic: `input_tokens = len(system + user)//4`, `output_tokens = len(text)//4` plus a model-dependent "thinking" pad (haiku 0, sonnet 150, opus 300).
  - Fake mode prices at the **nominal** model, so fake runs look like real-model economics.
- `python -m abyss.llm --smoke`: one real call per purpose in Haiku test mode, with a tiny schema/prompt. It prints each `LLMResult.usage` and the ledger total. This is the only real-network command in this task.

**Constraints:**
- Use `anthropic.AsyncAnthropic`. Catch `anthropic.APIStatusError` and `anthropic.APIConnectionError`, not bare `Exception`, around the SDK call.
- `max_retries` stays at the SDK default (2).
- **Fallback:** if `output_config.format` returns 400 on Haiku, don't hack around it. Drop the `format`, append `"Respond with only a JSON object matching this schema: …"` to the system prompt, and parse the first `{…}` span. Report in your summary which path was used.

**Acceptance:**
- [ ] `grep -rn "import anthropic\|from anthropic" backend/abyss` matches only `llm.py`.
- [ ] Fake-mode tests:
  - Each purpose returns the right shape.
  - Same input gives the same output.
  - Every call adds exactly one ledger entry.
  - Tests for the failure paths use a stub client injected through an optional `LLM(client=...)` ctor arg.
- [ ] `python -m abyss.llm --smoke` with a real key runs 4 Haiku calls and prints usage. The ledger JSONL has 4 lines, all with `model == "claude-haiku-4-5"`. The total is under $0.01.
- [ ] `pytest -q` is green with no network (verify: `ANTHROPIC_API_KEY= pytest -q`).

**Verify:** `ANTHROPIC_API_KEY= pytest -q && python -m abyss.llm --smoke && tail -4 runs/ledger.jsonl`

---

## T03 — Reputation store + scoring (pure)
**Track** B · **Stage** 1 · **Depends** T01 · *can run in parallel with T02*

**Owns:** `backend/abyss/reputation.py`, `backend/abyss/scoring.py`, `backend/tests/test_reputation.py`, `backend/tests/test_scoring.py`

**Build:**
```python
# scoring.py
@dataclass(frozen=True)
class ScoredBid:
    agent_id: str; promised_quality: int; predicted_output_tokens: int
    est_input_tokens: int; predicted_cost_usd: float; reputation: float; score: float

def predicted_cost(nominal_model: str, est_input_tokens: int, predicted_output_tokens: int) -> float
def score_bid(promised_quality: int, reputation: float, predicted_cost_usd: float, price_weight: float) -> float
def pick_winner(bids: list[ScoredBid]) -> tuple[ScoredBid, ScoredBid | None]   # (winner, runner_up), SPEC §3 tie-breaks
def clamp_bid(raw: dict) -> tuple[int, int, str]   # (tokens, quality, pitch) per SPEC §3.2

# reputation.py
class ReputationStore:
    def __init__(self, path: Path | None = None)   # loads if file exists, else REP_INIT everywhere
    def get(self, agent_id: str, task_type: str) -> float
    def update(self, agent_id: str, task_type: str, grade: int, promised: int) -> tuple[float, float, float]  # (old, new, ratio); persists if path
    def snapshot(self) -> dict[str, dict[str, float]]
    def reset(self) -> None                         # persists
```
All numbers use the SPEC §2 rounding. Persistence is a plain JSON file written atomically (write a tmp file, then `os.replace`).

**Acceptance:**
- [ ] For each of t1–t3 in the fixture, recomputing `predicted_cost_usd`, `score` and the winner/runner-up from the fixture's bid inputs reproduces the fixture values exactly.
- [ ] Recomputing `rep_update` from the fixture's `graded` reproduces old/new/ratio.
- [ ] Tie-break test: equal scores go to the lower cost; equal scores and equal costs go to agent order.
- [ ] Clamping test: tokens 5 → 50, quality 14 → 10, quality "7" → 7, a 200-char pitch → 80 chars.
- [ ] Persistence round-trip. `reset()` sets everything to 1.0.

**Verify:** `pytest -q tests/test_reputation.py tests/test_scoring.py`

---

## T04 — Prompts and role functions
**Track** B · **Stage** 1 · **Depends** T02, T03

**Owns:** `backend/abyss/prompts.py`, `backend/abyss/orchestrator.py`, `backend/abyss/agents.py`, `backend/abyss/reviewer.py`, `backend/tests/test_roles.py`

**Build:**
```python
# orchestrator.py
@dataclass
class TaskSpec: task_id: str; type: str; title: str; brief: str; depends_on: list[str]
async def split_job(llm: LLM, ledger: Ledger, job_text: str) -> tuple[list[TaskSpec], dict]   # (tasks, usage)

# agents.py
def build_work_prompt(job_text: str, task: TaskSpec, dep_outputs: dict[str, str]) -> tuple[str, str]  # (system, user)
def est_input_tokens(system: str, user: str) -> int                                                 # ceil(chars/4)
async def request_bid(llm, ledger, agent: AgentSpec, job_text, task: TaskSpec, dep_sizes: dict[str, int], reputation: float) -> tuple[dict, dict]  # (raw bid json, usage)
async def do_work(llm, ledger, agent: AgentSpec, job_text, task: TaskSpec, dep_outputs: dict[str, str]) -> tuple[str, dict]  # (output, usage)

# reviewer.py
async def review(llm, ledger, job_text, task: TaskSpec, dep_outputs: dict[str, str], output: str) -> tuple[int, str, dict]  # (grade, rationale, usage)
```
- **Split:**
  - Schema `{tasks:[{type: enum(research|writing|checking), title, brief, depends_on:[int]}]}`, where `depends_on` holds 0-based indices of earlier tasks.
  - Post-process in code:
    - Keep at most `MAX_TASKS`.
    - Drop self or forward dependencies.
    - Assign `t1..tN`.
    - Truncate the title to 40 chars and the brief to 300.
    - If there are fewer than 2 tasks, retry once, then raise.
  - Prompt guidance: prefer 3 tasks, and put a `writing` task before any final `checking`.
  - Model: `ORCHESTRATOR_MODEL`, `max_tokens=4096`, `effort=SPLIT_EFFORT`.
- **Bid:**
  - The prompt states the marketplace rules plainly: you're scored on promised quality × reputation minus price, and overpromising lowers your reputation.
  - It gives the agent its reputation for this task type ("1.0 = delivers what it promises") and the dependency **sizes**, not contents.
  - Model: the agent's nominal model, `max_tokens=2048`, `effort=BID_EFFORT`, with the schema from SPEC §3.
- **Work:**
  - A system prompt per task type with the length caps from SPEC §4.
  - Model: the agent's nominal model, `max_tokens=16000`, `effort=WORK_EFFORT`.
  - `est_input_tokens` must be computed on exactly the strings `do_work` sends.
- **Review:**
  - Blind (SPEC §4), using the per-type rubric.
  - Model: `REVIEWER_MODEL`, `max_tokens=2048`, `effort=REVIEW_EFFORT`, schema `{grade:int, rationale:str}`.
  - Clamp and truncate in code.
- All prompt text lives in `prompts.py` as module-level constants or `str.format` templates. No f-strings buried in the logic.
- The system prompts must not contain timestamps or other per-request noise.

**Acceptance:**
- [ ] Fake-mode tests for each function: shapes, clamping and dependency sanitization (feed a stub LLM that returns forward dependencies and 7 tasks).
- [ ] Test: the reviewer prompt contains neither the agent id nor the promised quality.
- [ ] Test: the bid prompt contains `str(len(dep_output))` and does **not** contain the dependency text.
- [ ] Real Haiku check (orchestrator runs it): `python -c` a single `split_job` on the fixture's job text returns 2–5 sane tasks. Paste the output in the summary.

**Verify:** `ANTHROPIC_API_KEY= pytest -q tests/test_roles.py`

---

## T05 — Market loop, event stream, headless CLI
**Track** B · **Stage** 1 · **Depends** T04 · **Stage 1 exit gate**

**Owns:** `backend/abyss/events.py`, `backend/abyss/market.py`, `backend/abyss/cli.py`, `backend/tests/test_market.py`

**Build:**
```python
# events.py
Sink = Callable[[dict], Awaitable[None]]
class EventStream:
    def __init__(self, sink: Sink)                  # seq starts at 0 and persists across jobs
    async def hello(self, rep: ReputationStore) -> None
    def start_job(self, job_id: str) -> None        # resets t origin
    async def emit(self, type: str, data: dict, job_id: str | None = ...) -> None  # stamps v, seq, t, job_id
def new_job_id() -> str                             # "j_" + 8 hex

# market.py
@dataclass
class JobResult: job_id: str; status: str; deliverable: str | None; ledger: Ledger; final: dict
async def run_job(job_text: str, *, stream: EventStream, llm: LLM, rep: ReputationStore,
                  price_weight: float = PRICE_WEIGHT,
                  fixed_agent_id: str | None = None,          # experiment: skip auction
                  tasks: list[TaskSpec] | None = None,        # experiment: reuse cached split
                  ) -> JobResult
```
- Implements SPEC §3, §4, §6 and §7.2 exactly: bids via `asyncio.gather(..., return_exceptions=True)`, stats snapshots at the three points, `final` computed from the ledger.
- `fixed_agent_id` → no bid calls and no `bid` events. Still emit `task_posted`, then `won{mode:"fixed", score:null, runner_up_*:null, scores:{}}`. `done.predicted_*` is `null`, and `graded.promised_quality` is `null`, so there's no rep update and no `rep_update` event.
- When `tasks` is given: no split call. Emit `job_split` with `usage` equal to a zero Usage for `ORCHESTRATOR_MODEL`.
- The CLI (`python -m abyss.cli`) supports:
  - `"job text"`
  - `--price-weight 1.0`
  - `--jsonl` (prints raw envelopes)
  - `--record PATH` (writes the full event list, including `hello`, as a JSON array in the fixture's format)
  - The default output is one readable line per event (e.g. `[t1] bid opus q=9 cost=$0.0159 score=7.410 "pitch"`), then the deliverable and a cost table by purpose and by agent.
- The CLI uses `ReputationStore(rep_path())`, so reputation persists across CLI runs.

**Constraints:** the market never touches `anthropic` or computes cost itself. Costs come from usage dicts and the `Ledger`.

**Acceptance:**
- [ ] Fake-mode test: run a job into a list sink, then `validate_stream(events)` passes.
- [ ] Fake-mode test: the ledger entry count equals 1 split + 3×N bids + N work + N review.
- [ ] Fake-mode test: the `final.total_cost_usd` event equals the sum of `ledger.jsonl` lines for that `job_id`.
- [ ] Failure tests with a stub LLM:
  - One bid raises → `bid{ok:false}`, the task still runs.
  - Work raises twice → `error` event, `final.status=="partial"`, reputation unchanged.
- [ ] Fixed-agent test: no bid calls in the ledger, and `won.mode=="fixed"`.
- [ ] Real Haiku run: `python -m abyss.cli "<fixture job text>" --record runs/haiku_run.json` completes. Then `python -m abyss.contract runs/haiku_run.json` → OK. Report the total cost (expected < $0.05).

**Verify:** `ANTHROPIC_API_KEY= pytest -q && python -m abyss.cli "Write a 100-word note on why the sky is blue, then fact-check it." --record runs/haiku_run.json && python -m abyss.contract runs/haiku_run.json`

---

## T06 — FastAPI WebSocket server
**Track** B · **Stage** 2 · **Depends** T05

**Owns:** `backend/abyss/server.py`, `backend/tests/test_server.py`

**Build:**
- `app = FastAPI()` with `GET /health` and `WS /ws`, per SPEC §8.
- Process-global `ReputationStore(rep_path())` and one `LLM()`.
- On connect: create an `EventStream` whose sink is `ws.send_json`, then send `hello`.
- Receive loop:
  - `start_job` → validate, then start `asyncio.create_task(run_job(...))`. Reject if one is already running for this connection.
  - `reset` → reject while running; otherwise `rep.reset()` and `hello`.
  - Bad JSON or an unknown type → `error{fatal:false}`.
- On `WebSocketDisconnect`: cancel the running job task and swallow `CancelledError`.
- Run with `uvicorn abyss.server:app --port 8000 --reload`. No auth. CORS isn't needed for WS.

**Acceptance:**
- [ ] Test (fake mode, `fastapi.testclient.TestClient.websocket_connect`):
  - Connect → `hello`.
  - `start_job` → receive events until `final`.
  - `validate_stream` passes on everything received.
- [ ] Test: a second `start_job` while one is running → `error`, and the first job still finishes.
- [ ] Test: `reset` → `hello` with every reputation at 1.0.
- [ ] Manual check (orchestrator): `ABYSS_FAKE_LLM=1 uvicorn …`, plus a 10-line `websockets` client script, streams a full job.

**Verify:** `ANTHROPIC_API_KEY= pytest -q tests/test_server.py`

---

## T07 — Web skeleton, contract types, fixture source, reducer, debug UI
**Track** F · **Stage** 3 · **Depends** T00 · *start at H1, in parallel with the backend*

**Owns:** everything under `web/` except `web/src/scene/**`

**Build:**
- Vite + React 18 + TypeScript + `pixi.js@^8` + `vitest`. Node ≥ 20.
- `npm run dev` runs a `predev`/`prebuild` script that copies `../fixtures/*.json` → `web/public/fixtures/` (gitignored).
- `src/contract.ts`: hand-mirrored TS types for SPEC §7 (discriminated union `AbyssEvent` on `type`). Include a comment with the contract version.
- `src/sources/types.ts`: `interface EventSource { start(onEvent: (e: AbyssEvent) => void): void; stop(): void; send?(msg: ClientMsg): void }`
- `src/sources/fixture.ts`: `FixtureSource(url, speed)`.
  - Fetches the JSON array and replays each event after `min(3000, max(0, t_i − t_{i−1})) / speed` ms.
  - `speed` comes from `?speed=` (default 1). The file comes from `?file=` (default `fake_run`, loaded from `/fixtures/<file>.json`). `?source=fixture` is the default until T10.
- `src/state/reducer.ts`: a pure `reduce(state: MarketState, ev: AbyssEvent): MarketState`, plus `initialState`. `MarketState` holds:
  - agents (with reputation per type and status `idle|bidding|working`)
  - the current job
  - `tasks: Record<id, TaskView>` and `taskOrder`, where TaskView has status `pending|open|assigned|working|done|graded|failed`, bids by agent, the winner, the output, the grade and the rationale
  - `stats`
  - `final`
  - `log` (last 200 events)
  - `connected: boolean`
- `src/state/store.ts`: a tiny subscribe/getState store around the reducer. No Redux or Zustand.
- `src/ui/DebugPanel.tsx`: a DOM-only view of the whole state:
  - agents with rep bars
  - task list with bids and winner
  - the stats table
  - the scrolling event log
  - the final deliverable

  **This is the fallback demo UI if visuals get cut, so make it legible.**
- `src/App.tsx`: layout is a canvas area (an empty div with id `stage` for T08) and the DebugPanel beside or below it. Use the pixel font "Silkscreen" from Google Fonts for DOM text.

**Acceptance:**
- [ ] `npm run dev` → the page replays `fake_run.json`. The DebugPanel ends with 3 graded tasks, total $0.06928, rep haiku/research 0.925 and opus/checking 0.97.
- [ ] `npm test`: a vitest suite reduces the whole fixture and asserts the final state (as above, plus each task's winner and status `graded`).
- [ ] The reducer ignores unknown event types and logs them to the console.
- [ ] `npm run build` and `tsc --noEmit` are clean.

**Verify:** `cd web && npm i && npm test && npm run build && npm run dev` (open `http://localhost:5173/?speed=4`)

---

## T08 — Static pixel scene
**Track** F · **Stage** 3 · **Depends** T07

**Owns:** `web/src/scene/**`. Shared edit: one line in `App.tsx` to mount the scene.

**Build:**
- `src/scene/Scene.ts`: `class MarketScene { static async create(el: HTMLElement): Promise<MarketScene>; render(state: MarketState): void; destroy(): void }`
- Pixi v8 API only:
  - `const app = new Application(); await app.init({...})`, and `app.canvas` (not `app.view`)
  - `Graphics().rect().fill()` (not `beginFill`)
  - `TextureSource.defaultOptions.scaleMode = 'nearest'`
- Logical resolution **480×270**, scaled by the largest integer that fits the container. Use CSS `image-rendering: pixelated`.
- All art comes from code: `src/scene/sprites.ts` defines sprites as string arrays (e.g. `"..aa.."`) plus a palette, turned into textures with `renderer.generateTexture`. No external image assets.
- Layout, left→right:
  - **harbor master** (orchestrator) at a **notice board** (the job's tasks as cards: pending/open/done, colored by type)
  - three **stalls**, one per agent, each with an awning in the agent color and a keeper sprite, name plate, and reputation bars for R/W/C
  - a **reviewer lighthouse** on the right
  - the sea (3 bands with a simple 2-frame wave shimmer via ticker, the only animation allowed in this task), boardwalk and sky
  - a coin **till** showing `stats.total_cost_usd`
- `render(state)` is idempotent and **fully state-driven**: calling it with any `MarketState` shows the correct board, stall statuses (idle/bidding/working glyph), rep bars, winner flag on the current task and total cost. No event handling here.
- Text: `BitmapText` or `Text` with the Silkscreen font, loaded via `document.fonts.load` before `create` resolves.

**Acceptance:**
- [ ] With the fixture replaying, the scene reflects the state at every step (spot-check with `?speed=0.5`). The final frame shows 3 done cards, the correct rep bars and the correct till total.
- [ ] Resizing the window keeps integer scaling and adds no scrollbars.
- [ ] Holds 60fps idle (Chrome performance panel); no textures are re-created per `render` call.
- [ ] A screenshot is attached to the Codex summary.

**Verify:** `npm run build && npm run dev`, then look at it.

---

## T09 — Animation director
**Track** F · **Stage** 4 · **Depends** T08 · **Cut-able (second in the cut order)**

**Owns:** `web/src/scene/director.ts`, `web/src/scene/fx/**`. Shared edit: one hook in `App.tsx`/store to forward events.

**Build:**
- `class Director { constructor(scene: MarketScene); onEvent(ev: AbyssEvent): void }`. It runs a FIFO queue of short tweens using the Pixi ticker; no tween library.
- If the queue backlog is more than 8, finish the pending animations instantly. The scene stays correct because it's state-driven.
- Animations:

  | event | animation |
  |---|---|
  | `job_split` | Harbor master pins cards to the board, 150ms each. |
  | `task_posted` | A card flies from the board to the center of the pier. |
  | `bid` | A speech bubble over the stall shows the pitch plus `q9 · 1.6¢`. `ok:false` → a grey "…" bubble. |
  | `won` | A flag drops on the winner's stall, losers' bubbles fade out, and the score shows as a floating number. |
  | `working` | The keeper bobs and sparks fly. |
  | `done` | Coins fly from the stall to the till, one coin per 0.1¢ of `usage.cost_usd` (min 1, max 20). |
  | `graded` | A beam from the lighthouse shows a big grade stamp. It's green if ≥ promised and red if < promised−1. |
  | `rep_update` | The rep bar tweens from old to new with a ▲/▼ glyph. |
  | `final` | A banner shows the total cost and mean grade. |
- Each animation lasts 600–1500ms at `speed=1`, and every duration is divided by `?speed`.

**Acceptance:**
- [ ] A full fixture replay at speed 1 is watchable and understandable without the DebugPanel. The orchestrator judges this.
- [ ] Replaying at `?speed=20` never desyncs: the final frame is identical to T08's final frame.
- [ ] No per-frame allocations in steady state (spot-check with the performance panel).

---

## T10 — Connect: WS source, job input, deliverable panel
**Track** F · **Stage** 5 · **Depends** T06, T07

**Owns:** `web/src/sources/ws.ts`, `web/src/ui/JobBar.tsx`, `web/src/ui/Deliverable.tsx`. Shared edit: `App.tsx` for source selection.

**Build:**
- `WsSource(url)`. `url` is `import.meta.env.VITE_WS_URL ?? "ws://localhost:8000/ws"`.
  - Reconnects with 1s/2s/4s backoff (max 5 attempts).
  - Sets `state.connected`.
  - `send(msg)` for `start_job` and `reset`.
- `?source=ws` selects it; `?source=fixture` (default) keeps the replay. In the header, show a badge with `HAIKU TEST MODE` when `hello.config.real_models === false`, `FAKE LLM` when `fake_llm`, and `LIVE` otherwise.
- `JobBar`:
  - a textarea for the job
  - a price-weight slider from 0 to 5, step 0.25, default from `hello`
  - a **Run** button, disabled while a job runs
  - a **Reset reputation** button
- `Deliverable`: after `final`, a modal/panel with the deliverable text, a per-task table (agent, grade/promised, cost) and the total.
- A new `job_split` clears the previous job's tasks and final. Reputation carries over.

**Acceptance:**
- [ ] With a fake-mode backend, Run in the browser shows the full job flowing through the scene and the DebugPanel.
- [ ] With a Haiku test-mode backend, the same works, and the badge says HAIKU TEST MODE.
- [ ] Killing the backend mid-job → the connected badge goes red, and restarting it reconnects. The job is lost; that's acceptable.
- [ ] Two jobs in a row: reputation from job 1 is visible in job 1's bids **and** in job 2's bids.

---

## T11 — Cost/quality experiment runner
**Track** B · **Stage** 6 · **Depends** T05 · **Never cut**

**Owns:** `backend/abyss/experiment.py`, `experiments/jobs.json`, `backend/tests/test_experiment.py`

**Question this answers:** does the market get close to always-Opus quality at a fraction of always-Opus cost, and does reputation learning help over successive jobs?

**Build:**
- `experiments/jobs.json` holds 6 short jobs, each designed to split into roughly 3 tasks. Mix them:
  - 2 factual explainers
  - 2 persuasive/short-form writing jobs
  - 2 jobs with a trap fact that a checker should catch

  Keep each job's deliverable ≤150 words.
- Arms:
  - `market@0` (price ignored), `market@1`, `market@3`
  - `fixed:haiku`, `fixed:sonnet`, `fixed:opus`
- Procedure:
  - Each job is split **once** with the orchestrator and the split is cached at `experiments/splits/<sha1(job)>.json`. Every arm reuses the same split.
  - Each arm runs all jobs **sequentially, in file order**, starting from a **fresh in-memory** `ReputationStore()` (no persistence) so the learning curve is visible.
  - The reviewer is the same for every arm.
  - Events go to a null sink. Each arm's `final` events are kept.
- Per-arm metrics:
  - `total_usd`, `work_usd`, `bid_usd`, `review_usd`, `mean_grade`
  - `usd_per_grade_point` = `(bid+work)/sum(grades)`
  - `wins[agent][task_type]`
  - `rep_final`
  - `per_job: [{job_idx, grade_mean, cost}]` (the learning curve)
- Output:
  - `experiments/results/<UTC timestamp>.json` holding all of the above plus config (`real_models`, the models, `price_weight`s, reviewer)
  - a sibling `.md` file with the arms table, sorted by cost
  - the same table printed to stdout
- CLI:
  ```
  python -m abyss.experiment [--jobs experiments/jobs.json] [--arms all|market@1,fixed:opus,...] [--estimate] [--concurrency 1]
  ```
  `--estimate` makes no calls. It prints the call counts per arm and a USD upper bound, assuming 1k input and 1.5k output tokens per work call and 600 input and 300 output per bid/review.

**Constraints:**
- All LLM access goes through `run_job`, so there are no new model call sites.
- `--concurrency` > 1 runs arms in parallel, never jobs within an arm, because the reputation order matters.

**Acceptance:**
- [ ] Fake mode: `ABYSS_FAKE_LLM=1 python -m abyss.experiment --arms all` finishes in under 2 minutes with `ABYSS_FAKE_DELAY=0.01` and writes both files.
- [ ] Test: the split cache is hit on the second run (the ledger has 0 split calls).
- [ ] Test: fixed arms have `bid_usd == 0`.
- [ ] Haiku test-mode run on `--arms market@1,fixed:haiku`: the output is sane. Report the cost.
- [ ] **The real-model run is gated.** The orchestrator shows `--estimate` to the human, gets a go-ahead, and then runs `ABYSS_REAL_MODELS=1 python -m abyss.experiment --arms all`.

---

## T12 — Experiment results view
**Track** F · **Stage** 6 · **Depends** T11, T07 · *cut to "table in README" if behind*

**Owns:** `web/src/ui/Results.tsx`, `web/src/ui/results/**`. Shared edits: a `?view=results` route in `App.tsx`, and extend the `predev` copy script to include `experiments/results/*.json`.

**Build:**
- An SVG scatter (no chart library): x = total USD, y = mean grade, one labelled point per arm. `market@*` points are connected as a line (the price-weight frontier).
- A small multiple per market arm showing grade by job index (the learning curve), plus the final rep heatmap (agent × type).
- A plain table under the charts with the `.md` numbers.
- It loads the newest results file listed in an index JSON written by the copy script.

**Acceptance:**
- [ ] Renders the fake-mode results file and the real results file.
- [ ] Every number on the chart matches the `.md` table.

---

## T13 — Polish (time-boxed; first to cut)
Pick in this order and stop at the time box. Each item is a separate mini-brief I'll write when we get there:

1. Rep sparkline history per stall (needs `rep_update` history in the reducer).
2. A "vs all-Opus" line in the HUD using the experiment's measured ratio (static number from the results file, clearly labelled as measured offline).
3. Sound blips on bid, won and graded (WebAudio oscillator; no assets).
4. A job presets dropdown (the 6 experiment jobs).
5. Idle ambient animation (gulls, boats).

## T14 — Freeze
- README: what it is, the 3-command run (backend, frontend, fixture-only mode), env vars, cost safety, and the experiment headline table.
- Record a real-model demo run (`--record fixtures/demo_run.json`, with approval), so the demo can fall back to `?source=fixture&file=demo_run` if the network fails.
- Demo script: 90 seconds covering job → bids → surprise winner → grade → rep drop → final cost → experiment chart.
- Tag `v1-demo`.
