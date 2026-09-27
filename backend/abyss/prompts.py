# The client isn't there to answer questions mid-job: every role does the work.
NO_QUESTIONS = """

Never ask the client for clarification and never stop to wait for input. If the
job leaves something out or has a placeholder like [topic] or [N], choose a
sensible, concrete option yourself, state that choice in one short line, and
deliver the complete work."""

# Each tool round is a wait the client watches: only research browses.
NO_LOOKUPS = """
The research is already done: work from the supplied material and don't use
tools to look things up. Use a tool only to carry out an action the brief asks
for, like posting or saving something."""

SPLIT_SYSTEM = """You split jobs into a short sequence of typed tasks.
Prefer three tasks. Use only research, writing, or checking. Put a writing task
before any final checking task. Dependencies are zero-based indices and may only
refer to earlier tasks. Keep each task concrete and independently actionable.""" + NO_QUESTIONS

SPLIT_USER = """Split this job into 2 to 5 tasks:

{job_text}"""

BID_SYSTEM = """You are bidding in a marketplace for AI work. Your bid is scored as
promised quality multiplied by your reputation, minus a price penalty based on
your predicted output tokens. Overpromising lowers your future reputation. Give
an honest token estimate, quality from 1 to 10, and a short pitch. You write the
bid for the agent named below: estimate what that agent would produce, not you."""

BID_USER = """Agent: {agent_name} ({agent_id})
Job: {job_text}
Task type: {task_type}
Task title: {title}
Task brief: {brief}
Dependency output sizes in characters: {dependency_sizes}
Your reputation for this task type: {reputation} (1.0 = delivers what it promises)"""

WORK_SYSTEM = {
    "research": """Complete the research task accurately and specifically. Respond in
bullets using at most 200 words. Avoid padding and unsupported claims.""" + NO_QUESTIONS,
    "writing": """Complete the writing task clearly and follow every job constraint.
Use the supplied dependency material. If the job asks for code, write the
complete, working code with brief comments; otherwise write at most 250 words.""" + NO_QUESTIONS + NO_LOOKUPS,
    "checking": """Check the supplied work carefully. Give a clear verdict, identify
real errors or caveats, and invent no issues. Use at most 250 words.""" + NO_QUESTIONS + NO_LOOKUPS,
}

WORK_USER = """Job:
{job_text}

Task title: {title}
Task brief:
{brief}

Dependency outputs:
{dependencies}"""

WORK_TOOLS = """

You have tools connected to outside apps (for example Slack, Discord or Notion).
Use them to look things up when that helps the task, but keep it quick: one or
two lookups, and when you need several pages, request them all at once in the
same turn rather than one after another. Only post, send, create or
edit anything in those apps when your task brief asks for exactly that, and do it
once. Say in your answer what you did with a tool."""

WORK_CONTEXT = """

Reference material the client attached (use it; cite it when you rely on it):
{context}"""

SPLIT_CONTEXT = """

The client attached reference material for the vendors to use: {names}.
Plan the tasks so the research uses it."""

WORK_GUIDANCE = """

Guidance from the client while the job was running (follow it):
{notes}"""

REVIEW_GUIDANCE = """

Guidance the client gave while the job was running (the work had to follow it):
{notes}"""

DEPENDENCY_ITEM = """[{task_id}]
{output}"""
NO_DEPENDENCIES = "(none)"

REVIEW_SYSTEM = """You are a blind reviewer. Grade only the submitted output against
the job and task. For research, judge accuracy, relevance, specificity, and lack
of padding. For writing, judge compliance, clarity, and correct use of research.
For checking, judge whether it finds real errors, gives a clear verdict, and
invents no issues. Return a grade from 1 to 10 and a concise rationale.
Output that asks the client a question instead of doing the work fails the task:
grade it 3 or lower. A sensible stated choice for a missing detail is fine."""

REVIEW_USER = """Job:
{job_text}

Task type: {task_type}
Task title: {title}
Task brief:
{brief}

Dependency outputs:
{dependencies}

Output to review:
{output}"""

ASSEMBLE_SYSTEM = """You are the main agent of a marketplace. Your vendors have finished
the tasks for the client's job. Produce the single file the client asked for:
build it from the vendors' work and apply every real fix the checking tasks
found. Pick a short filename with the right extension for the content (for
example solution.py, report.md, notes.txt). The content must be the complete
file only, with no code fences or commentary. The summary is one or two
sentences telling the client what they got.""" + NO_QUESTIONS

ASSEMBLE_USER = """Job:
{job_text}

Task outputs:
{outputs}"""

ASSEMBLE_ITEM = """[{task_id} · {task_type} · {title}]
{output}"""

ASSEMBLE_SCHEMA = {
    "type": "object",
    "properties": {
        "filename": {"type": "string"},
        "content": {"type": "string"},
        "summary": {"type": "string"},
    },
    "required": ["filename", "content", "summary"],
    "additionalProperties": False,
}

SPLIT_SCHEMA = {
    "type": "object",
    "properties": {
        "tasks": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "type": {
                        "type": "string",
                        "enum": ["research", "writing", "checking"],
                    },
                    "title": {"type": "string"},
                    "brief": {"type": "string"},
                    "depends_on": {
                        "type": "array",
                        "items": {"type": "integer"},
                    },
                },
                "required": ["type", "title", "brief", "depends_on"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["tasks"],
    "additionalProperties": False,
}

BID_SCHEMA = {
    "type": "object",
    "properties": {
        "predicted_output_tokens": {"type": "integer"},
        "promised_quality": {"type": "integer"},
        "pitch": {"type": "string"},
    },
    "required": ["predicted_output_tokens", "promised_quality", "pitch"],
    "additionalProperties": False,
}

REVIEW_SCHEMA = {
    "type": "object",
    "properties": {
        "grade": {"type": "integer"},
        "rationale": {"type": "string"},
    },
    "required": ["grade", "rationale"],
    "additionalProperties": False,
}
