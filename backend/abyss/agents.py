from __future__ import annotations

import json
import math

from . import prompts
from .config import AgentSpec, BID_EFFORT, WORK_EFFORT
from .ledger import Ledger
from .llm import LLM
from .orchestrator import TaskSpec


def guidance_text(notes: list[str]) -> str:
    return "\n".join(f"- {note}" for note in notes)


def build_work_prompt(
    job_text: str, task: TaskSpec, dep_outputs: dict[str, str], notes: list[str] | None = None
) -> tuple[str, str]:
    dependencies = _dependency_text(task, dep_outputs)
    system = prompts.WORK_SYSTEM[task.type]
    user = prompts.WORK_USER.format(
        job_text=job_text,
        title=task.title,
        brief=task.brief,
        dependencies=dependencies,
    )
    if notes:
        user += prompts.WORK_GUIDANCE.format(notes=guidance_text(notes))
    return system, user


def est_input_tokens(system: str, user: str) -> int:
    return math.ceil(len(system + user) / 4)


async def request_bid(
    llm: LLM,
    ledger: Ledger,
    agent: AgentSpec,
    job_text: str,
    task: TaskSpec,
    dep_sizes: dict[str, int],
    reputation: float,
) -> tuple[dict, dict]:
    result = await llm.call(
        ledger=ledger,
        purpose="bid",
        nominal_model=agent.model,
        system=prompts.BID_SYSTEM,
        user=prompts.BID_USER.format(
            agent_name=agent.display_name,
            agent_id=agent.agent_id,
            job_text=job_text,
            task_type=task.type,
            title=task.title,
            brief=task.brief,
            dependency_sizes=json.dumps(dep_sizes, sort_keys=True),
            reputation=reputation,
        ),
        max_tokens=2048,
        effort=BID_EFFORT,
        schema=prompts.BID_SCHEMA,
        task_id=task.task_id,
        agent_id=agent.agent_id,
    )
    return result.data or {}, result.usage


async def do_work(
    llm: LLM,
    ledger: Ledger,
    agent: AgentSpec,
    job_text: str,
    task: TaskSpec,
    dep_outputs: dict[str, str],
    notes: list[str] | None = None,
) -> tuple[str, dict]:
    system, user = build_work_prompt(job_text, task, dep_outputs, notes)
    result = await llm.call(
        ledger=ledger,
        purpose="work",
        nominal_model=agent.model,
        system=system,
        user=user,
        max_tokens=16000,
        effort=WORK_EFFORT,
        task_id=task.task_id,
        agent_id=agent.agent_id,
    )
    return result.text, result.usage


def _dependency_text(task: TaskSpec, dep_outputs: dict[str, str]) -> str:
    blocks = [
        prompts.DEPENDENCY_ITEM.format(task_id=task_id, output=dep_outputs[task_id])
        for task_id in task.depends_on
        if task_id in dep_outputs
    ]
    return "\n\n".join(blocks) if blocks else prompts.NO_DEPENDENCIES
