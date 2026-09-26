from __future__ import annotations

from . import prompts
from .config import REVIEWER_MODEL, REVIEW_EFFORT
from .ledger import Ledger
from .llm import LLM
from .orchestrator import TaskSpec


async def review(
    llm: LLM,
    ledger: Ledger,
    job_text: str,
    task: TaskSpec,
    dep_outputs: dict[str, str],
    output: str,
    notes: list[str] | None = None,
) -> tuple[int, str, dict]:
    dependencies = _dependency_text(task, dep_outputs)
    user = prompts.REVIEW_USER.format(
        job_text=job_text,
        task_type=task.type,
        title=task.title,
        brief=task.brief,
        dependencies=dependencies,
        output=output,
    )
    if notes:
        user += prompts.REVIEW_GUIDANCE.format(notes="\n".join(f"- {note}" for note in notes))
    result = await llm.call(
        ledger=ledger,
        purpose="review",
        nominal_model=REVIEWER_MODEL,
        system=prompts.REVIEW_SYSTEM,
        user=user,
        max_tokens=2048,
        effort=REVIEW_EFFORT,
        schema=prompts.REVIEW_SCHEMA,
        task_id=task.task_id,
    )
    data = result.data or {}
    grade = min(10, max(1, _as_int(data.get("grade"), 1)))
    rationale_value = data.get("rationale", "")
    rationale = rationale_value if isinstance(rationale_value, str) else ""
    return grade, rationale[:200], result.usage


def _dependency_text(task: TaskSpec, dep_outputs: dict[str, str]) -> str:
    blocks = [
        prompts.DEPENDENCY_ITEM.format(task_id=task_id, output=dep_outputs[task_id])
        for task_id in task.depends_on
        if task_id in dep_outputs
    ]
    return "\n\n".join(blocks) if blocks else prompts.NO_DEPENDENCIES


def _as_int(value: object, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        return default
