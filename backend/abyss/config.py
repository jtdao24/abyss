from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _load_dotenv(*paths: Path) -> None:
    """Fill unset env vars from .env files (API keys for local runs).

    Real environment variables always win. ABYSS_NO_DOTENV=1 skips this (tests).
    """
    if os.getenv("ABYSS_NO_DOTENV") == "1":
        return
    for path in paths:
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError:
            continue
        for line in lines:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            value = value.strip().strip('"').strip("'")
            if value:
                os.environ.setdefault(key.strip(), value)


# The repo-root .env (start.py's) first, then backend/.env.
_load_dotenv(Path(__file__).resolve().parents[2] / ".env", Path(__file__).resolve().parents[1] / ".env")


@dataclass(frozen=True)
class AgentSpec:
    agent_id: str
    display_name: str
    model: str
    color: str


# The three stalls. `model` is a tier (budget / standard / premium); the AI a
# session runs on (OpenAI or Meta Muse Spark) serves each tier with a real model
# (provider_tiers). Agent ids are the event contract's stall ids (VENDOR 3/2/1).
AGENTS = [
    AgentSpec("haiku", "Budget", "budget", "#4fb3a9"),
    AgentSpec("sonnet", "Standard", "standard", "#e8a33d"),
    AgentSpec("opus", "Premium", "premium", "#8e6cc9"),
]
TIERS = ("budget", "standard", "premium")

# USD per million input / output tokens, per real model (filled below).
PRICES: dict[str, tuple[float, float]] = {}
TASK_TYPES: list[str] = ["research", "writing", "checking"]

PRICE_WEIGHT = float(os.getenv("ABYSS_PRICE_WEIGHT", "1.0"))
REP_INIT = 1.0
REP_ALPHA = 0.3
REP_MIN = 0.0
REP_MAX = 2.0
MAX_TASKS = 5
WORK_EFFORT = "medium"
BID_EFFORT = "low"
REVIEW_EFFORT = "low"
SPLIT_EFFORT = "low"
ASSEMBLE_EFFORT = "medium"

ORCHESTRATOR_MODEL = "standard"  # the main agent's tier
REVIEWER_MODEL = "standard"
# Every stall's bid is written by this tier. A bid is only a quote, and the market
# still prices it at the stall's own model, so the premium model is paid only
# for work it wins (on OpenAI, Astra bids cost more than all the Luna work).
BID_MODEL = "budget"
# The premium stall is a backup. It only bids on a task type once every cheaper
# stall's reputation there is below this (they keep delivering less than they
# promise), or when every cheaper bid fails. At price weight 0 it always bids.
PREMIUM_BACKUP_BELOW = float(os.getenv("ABYSS_PREMIUM_BACKUP_BELOW", "0.9"))
REPO_ROOT = Path(__file__).resolve().parents[2]


def real_models() -> bool:
    """Each tier runs on its real model (the default). ABYSS_TEST_MODE=1 (or
    ABYSS_REAL_MODELS=0) sends every call to the cheap tier instead."""
    explicit = os.getenv("ABYSS_REAL_MODELS")
    if explicit is not None and explicit != "":
        return explicit == "1"
    return os.getenv("ABYSS_TEST_MODE") != "1"


def fake_llm() -> bool:
    return os.getenv("ABYSS_FAKE_LLM") == "1"


def fake_delay() -> float:
    return float(os.getenv("ABYSS_FAKE_DELAY", "0.3"))


def ledger_path() -> Path:
    override = os.getenv("ABYSS_LEDGER_PATH")
    return Path(override) if override is not None else REPO_ROOT / "runs" / "ledger.jsonl"


def rep_path() -> Path:
    override = os.getenv("ABYSS_REP_PATH")
    return Path(override) if override is not None else REPO_ROOT / "runs" / "reputation.json"


def resolve_model(nominal: str) -> str:
    """The tier a call really runs on: its own, or the budget tier in test mode."""
    if real_models():
        return nominal
    return "budget"


# ---- OpenAI-compatible providers (OpenAI, Meta Muse Spark) -----------------
# ABYSS_PROVIDER picks where calls go by default; a session can pick another.
# Agents keep their identities (stalls, bids, reputation); each tier is served
# by the provider's model below, overridable per tier with env vars.
OPENAI_PRICES: dict[str, tuple[float, float]] = {
    # USD per million input / output tokens (standard tier, September 2026).
    "gpt-6-luna": (0.10, 0.50),
    "gpt-6-sol": (2.00, 10.00),
    "gpt-6-astra": (10.00, 50.00),
    "gpt-5-nano": (0.05, 0.40),
    "gpt-5-mini": (0.25, 2.00),
    "gpt-5": (1.25, 10.00),
    "gpt-4.1-nano": (0.10, 0.40),
    "gpt-4.1-mini": (0.40, 1.60),
    "gpt-4.1": (2.00, 8.00),
    "gpt-4o-mini": (0.15, 0.60),
    "gpt-4o": (2.50, 10.00),
}
META_PRICES: dict[str, tuple[float, float]] = {
    "muse-spark-1.3": (1.25, 4.25),
    "muse-spark-1.3-contributor": (0.10, 0.20),
}
FALLBACK_PRICE = (2.00, 10.00)  # for a model these tables don't know
PRICES.update(OPENAI_PRICES)
PRICES.update(META_PRICES)
META_BASE_URL = "https://api.meta.ai/v1"
PROVIDERS = ("openai", "meta")
PROVIDER_LABELS = {"openai": "OpenAI", "meta": "Meta Muse Spark"}


def provider() -> str:
    """The default AI: ABYSS_PROVIDER (openai or meta), else whichever has a key."""
    chosen = os.getenv("ABYSS_PROVIDER", "").strip().lower()
    if chosen in PROVIDERS:
        return chosen
    if not os.getenv("OPENAI_API_KEY") and meta_api_key():
        return "meta"
    return "openai"


MODEL_LABELS = {
    "gpt-6-luna": "GPT-6 Luna",
    "gpt-6-sol": "GPT-6 Sol",
    "gpt-6-astra": "GPT-6 Astra",
    "gpt-5-nano": "GPT-5 nano",
    "gpt-5-mini": "GPT-5 mini",
    "gpt-5": "GPT-5",
    "gpt-4.1-nano": "GPT-4.1 nano",
    "gpt-4.1-mini": "GPT-4.1 mini",
    "gpt-4.1": "GPT-4.1",
    "gpt-4o-mini": "GPT-4o mini",
    "gpt-4o": "GPT-4o",
    "muse-spark-1.3": "Muse Spark 1.3",
    "muse-spark-1.3-contributor": "Muse Spark 1.3 (contributor)",
}


def model_label(model: str) -> str:
    return MODEL_LABELS.get(model) or next((a.display_name for a in AGENTS if a.model == model), model)


def tier_model(nominal: str, provider_name: str | None = None) -> str:
    """The provider's model for a tier, ignoring test mode: what the stall *is*
    (used for its name and for pricing bids, so the market behaves the same)."""
    return provider_tiers(provider_name or provider()).get(nominal, nominal)


def agents_for(provider_name: str | None = None) -> list[dict]:
    """The three stalls as the page should show them for a provider."""
    return [
        {
            "agent_id": agent.agent_id,
            "display_name": model_label(tier_model(agent.model, provider_name)),
            "model": tier_model(agent.model, provider_name),
            "color": agent.color,
        }
        for agent in AGENTS
    ]


def meta_api_key() -> str | None:
    return os.getenv("MODEL_API_KEY") or os.getenv("META_API_KEY")


def provider_tiers(name: str) -> dict[str, str]:
    """Tier (budget / standard / premium) -> the model this AI serves it with."""
    if name == "meta":
        return {
            "budget": os.getenv("ABYSS_META_CHEAP", "muse-spark-1.3"),
            "standard": os.getenv("ABYSS_META_MID", "muse-spark-1.3"),
            "premium": os.getenv("ABYSS_META_TOP", "muse-spark-1.3"),
        }
    return {
        "budget": os.getenv("ABYSS_OPENAI_CHEAP", "gpt-6-luna"),
        "standard": os.getenv("ABYSS_OPENAI_MID", "gpt-6-sol"),
        "premium": os.getenv("ABYSS_OPENAI_TOP", "gpt-6-astra"),
    }


def served_model(provider_name: str, nominal: str) -> str:
    """The model that actually answers a call: test mode first sends every call
    to the cheap tier (resolve_model), then the provider maps the tier."""
    model = provider_tiers(provider_name).get(resolve_model(nominal), resolve_model(nominal))
    PRICES.setdefault(model, FALLBACK_PRICE)
    return model


def available_providers() -> list[str]:
    """Providers with a key configured, the default first. Fake mode needs no key."""
    default = provider()
    if fake_llm():
        return [default]
    keys = {"openai": os.getenv("OPENAI_API_KEY"), "meta": meta_api_key()}
    found = [name for name, key in keys.items() if key]
    return sorted(found, key=lambda name: name != default) or [default]


MAX_TOOL_ROUNDS = 8  # tool calls a vendor may chain in one piece of work


def mcp_config_path() -> Path:
    override = os.getenv("ABYSS_MCP_CONFIG")
    return Path(override) if override is not None else REPO_ROOT / "mcp.json"
