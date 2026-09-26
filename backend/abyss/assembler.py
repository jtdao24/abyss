"""The main agent's last step: turn the vendors' task outputs into one file."""
from __future__ import annotations

import re

from . import prompts
from .config import ASSEMBLE_EFFORT, ORCHESTRATOR_MODEL
from .ledger import Ledger
from .llm import LLM
from .orchestrator import TaskSpec

DEFAULT_FILENAME = "abyss_result.md"


def safe_filename(name: object) -> str:
    """A plain file name: no folders, only ordinary characters, keeping its extension."""
    base = re.split(r"[/\\]", str(name or ""))[-1]
    base = re.sub(r"[^A-Za-z0-9._ -]", "_", base).strip(" .")
    stem, dot, ext = base.rpartition(".")
    if not dot:
        stem, ext = base, "md"
    stem, ext = stem.strip(" ._")[:60], ext[:10]
    return f"{stem}.{ext}" if stem and ext else DEFAULT_FILENAME


async def assemble(
    llm: LLM,
    ledger: Ledger,
    job_text: str,
    completed: list[tuple[TaskSpec, str]],
    notes: list[str] | None = None,
) -> tuple[str, str, str, dict]:
    """Returns (filename, content, summary, usage)."""
    outputs = "\n\n".join(
        prompts.ASSEMBLE_ITEM.format(task_id=task.task_id, task_type=task.type, title=task.title, output=output)
        for task, output in completed
    )
    user = prompts.ASSEMBLE_USER.format(job_text=job_text, outputs=outputs)
    if notes:
        user += prompts.WORK_GUIDANCE.format(notes="\n".join(f"- {note}" for note in notes))
    result = await llm.call(
        ledger=ledger,
        purpose="assemble",
        nominal_model=ORCHESTRATOR_MODEL,
        system=prompts.ASSEMBLE_SYSTEM,
        user=user,
        max_tokens=16000,
        effort=ASSEMBLE_EFFORT,
        schema=prompts.ASSEMBLE_SCHEMA,
    )
    data = result.data or {}
    content = data.get("content")
    if not isinstance(content, str) or not content.strip():
        raise ValueError("assembled file is empty")
    summary = data.get("summary") if isinstance(data.get("summary"), str) else ""
    return safe_filename(data.get("filename")), content, summary[:300], result.usage
