"""The Tools panel's edits to mcp.json, plus the keys those servers need.

mcp.json only ever holds `${VAR}` references; the values the user pastes go
to backend/.env (gitignored) and into this process's environment, so a server
can start right away. Nothing here ever returns a secret's value, only
whether it is set.
"""
from __future__ import annotations

import copy
import json
import os
import re
import shutil
from pathlib import Path

from . import config
from .mcp_catalog import BY_ID, CATALOG
from .tools import _VAR

ENV_FILE = Path(__file__).resolve().parents[1] / ".env"
_NAME = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
_ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
_PARAM = re.compile(r"\{([a-z_]+)\}")


class McpConfigError(ValueError):
    """A bad request from the Tools panel (shown to the user as is)."""


# ------------------------------------------------------------------ mcp.json
def read_raw(path: Path | None = None) -> dict[str, dict]:
    """Servers exactly as written (with ${VAR}s, disabled ones included)."""
    path = path or config.mcp_config_path()
    if not path.exists():
        return {}
    raw = json.loads(path.read_text(encoding="utf-8"))
    servers = raw.get("mcpServers", {})
    if not isinstance(servers, dict):
        raise McpConfigError(f"{path.name}: mcpServers must be an object")
    return servers


def write_raw(servers: dict[str, dict], path: Path | None = None) -> None:
    path = path or config.mcp_config_path()
    try:
        raw = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    except ValueError:
        raw = {}
    raw["mcpServers"] = servers
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(raw, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def env_refs(spec: object) -> list[str]:
    """Every ${VAR} a server spec uses, in order."""
    found: list[str] = []
    if isinstance(spec, str):
        found = _VAR.findall(spec)
    elif isinstance(spec, list):
        for item in spec:
            found += env_refs(item)
    elif isinstance(spec, dict):
        for item in spec.values():
            found += env_refs(item)
    return list(dict.fromkeys(found))


def missing_env(spec: dict) -> list[str]:
    return [var for var in env_refs(spec) if not os.environ.get(var)]


# ------------------------------------------------------------------ .env
def save_env(updates: dict[str, str], path: Path | None = None) -> None:
    """Set keys in backend/.env (replacing old values) and in this process."""
    path = path or ENV_FILE
    clean: dict[str, str] = {}
    for key, value in updates.items():
        value = (value or "").strip()
        if not _ENV_NAME.match(key):
            raise McpConfigError(f"{key!r} isn't a valid key name")
        if not value:
            continue
        if any(c in value for c in "\r\n\0"):
            raise McpConfigError(f"{key} can't contain line breaks")
        clean[key] = value
    if not clean:
        return
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    remaining = dict(clean)
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("#") or "=" not in stripped:
            continue
        key = stripped.split("=", 1)[0].strip()
        if key in remaining:
            lines[i] = f"{key}={remaining.pop(key)}"
    lines += [f"{key}={value}" for key, value in remaining.items()]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    os.environ.update(clean)


# ------------------------------------------------------------------ edits
def _check_name(name: str, servers: dict[str, dict], new: bool) -> None:
    if not isinstance(name, str) or not _NAME.match(name):
        raise McpConfigError("name must be 1-32 letters, digits, - or _")
    if new and name in servers:
        raise McpConfigError(f"there is already a server called {name!r}")
    if not new and name not in servers:
        raise McpConfigError(f"no server called {name!r}")


def _fill_params(value: object, params: dict[str, str]) -> object:
    if isinstance(value, str):
        return _PARAM.sub(lambda m: params[m.group(1)], value)
    if isinstance(value, list):
        return [_fill_params(item, params) for item in value]
    if isinstance(value, dict):
        return {key: _fill_params(item, params) for key, item in value.items()}
    return value


def add_from_catalog(catalog_id: str, name: str | None, params: dict | None, secrets: dict | None) -> str:
    entry = BY_ID.get(catalog_id)
    if entry is None:
        raise McpConfigError(f"unknown catalog server {catalog_id!r}")
    servers = read_raw()
    name = name or catalog_id
    _check_name(name, servers, new=True)
    values: dict[str, str] = {}
    for param in entry.get("params", []):
        value = str((params or {}).get(param["key"]) or "").strip()
        if not value:
            raise McpConfigError(f"{param['label']} is required")
        values[param["key"]] = value
    _save_secrets(entry, secrets)
    spec = _fill_params(copy.deepcopy(entry["spec"]), values)
    spec["catalog"] = catalog_id
    servers[name] = spec
    write_raw(servers)
    return name


def _save_secrets(entry: dict, secrets: dict | None) -> None:
    allowed = {s["var"] for s in entry.get("secrets", [])}
    updates = {k: v for k, v in (secrets or {}).items() if k in allowed and isinstance(v, str)}
    save_env(updates)


def add_custom(name: str, spec: dict, secrets: dict | None = None) -> str:
    servers = read_raw()
    _check_name(name, servers, new=True)
    clean: dict = {}
    if spec.get("url"):
        url = str(spec["url"]).strip()
        if not url.startswith(("http://", "https://")):
            raise McpConfigError("url must start with http:// or https://")
        clean["url"] = url
        if spec.get("headers"):
            clean["headers"] = _str_map(spec["headers"], "headers")
    elif spec.get("command"):
        clean["command"] = str(spec["command"]).strip()
        args = spec.get("args") or []
        if not isinstance(args, list) or not all(isinstance(a, str) for a in args):
            raise McpConfigError("args must be a list of strings")
        clean["args"] = args
        if spec.get("env"):
            clean["env"] = _str_map(spec["env"], "env")
    else:
        raise McpConfigError("give a command (local server) or a url (remote server)")
    # Keys typed straight into env/headers go to .env; mcp.json keeps ${VAR}.
    if secrets:
        save_env({k: v for k, v in secrets.items() if isinstance(v, str) and k in env_refs(clean)})
    servers[name] = clean
    write_raw(servers)
    return name


def _str_map(value: object, label: str) -> dict[str, str]:
    if not isinstance(value, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in value.items()):
        raise McpConfigError(f"{label} must map names to strings")
    return value


def update(name: str, disabled: bool | None = None, secrets: dict | None = None, allow: list | None | bool = False) -> None:
    servers = read_raw()
    _check_name(name, servers, new=False)
    spec = servers[name]
    if disabled is not None:
        if disabled:
            spec["disabled"] = True
        else:
            spec.pop("disabled", None)
    if allow is not False:
        if allow is None:
            spec.pop("allow", None)
        elif isinstance(allow, list) and all(isinstance(a, str) for a in allow):
            spec["allow"] = allow
        else:
            raise McpConfigError("allow must be a list of tool names or null")
    if secrets:
        save_env({k: v for k, v in secrets.items() if isinstance(v, str) and k in env_refs(spec)})
    write_raw(servers)


def remove(name: str) -> None:
    servers = read_raw()
    _check_name(name, servers, new=False)
    del servers[name]
    write_raw(servers)


# ------------------------------------------------------------------ view
def runtimes() -> dict[str, bool]:
    return {"npx": shutil.which("npx") is not None, "uvx": shutil.which("uvx") is not None}


def overview(status: dict[str, dict], activity: list[dict], config_error: str | None, pending_reload: bool) -> dict:
    """Everything the Tools panel shows. Secrets appear as set/unset only."""
    try:
        raw = read_raw()
    except (OSError, ValueError) as exc:
        raw, config_error = {}, config_error or str(exc)
    servers = []
    for name, spec in raw.items():
        state = status.get(name) or {}
        missing = missing_env(spec)
        if spec.get("disabled"):
            shown = "disabled"
        elif missing:
            shown = "needs_keys"
        else:
            shown = state.get("state", "stopped")  # added since the last reload: "stopped"
        entry = BY_ID.get(spec.get("catalog", ""))
        servers.append({
            "name": name,
            "catalog": spec.get("catalog"),
            "label": entry["label"] if entry else name,
            "kind": "remote" if "url" in spec else "local",
            "target": spec.get("url") or " ".join([spec.get("command", ""), *spec.get("args", [])]).strip(),
            "state": shown,
            "error": state.get("error"),
            "tools": state.get("tools", []),
            "allow": spec.get("allow"),
            "keys": [{"var": var, "set": bool(os.environ.get(var))} for var in env_refs(spec)],
            "missing": missing,
        })
    catalog = [
        {
            "id": e["id"], "label": e["label"], "category": e["category"], "description": e["description"],
            "runtime": e["runtime"], "params": e.get("params", []),
            "secrets": [{**s, "set": bool(os.environ.get(s["var"]))} for s in e.get("secrets", [])],
            "added": any(spec.get("catalog") == e["id"] for spec in raw.values()),
        }
        for e in CATALOG
    ]
    return {
        "servers": servers,
        "catalog": catalog,
        "runtimes": runtimes(),
        "activity": list(reversed(activity))[:40],
        "config_error": config_error,
        "pending_reload": pending_reload,
        "config_file": config.mcp_config_path().name,
    }
