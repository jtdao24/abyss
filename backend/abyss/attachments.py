"""Files and links a session can use as reference material.

The page uploads a file (PDF, CSV, TXT, MD, JSON) as base64, or gives a URL;
this extracts plain text and keeps it under runs/attachments/<id>.json. When a
session starts with attachment ids, their text is added to every vendor's work
prompt (capped, so a big file can't blow up the token bill).
"""
from __future__ import annotations

import base64
import binascii
import asyncio
import html
import io
import ipaddress
import json
import re
import secrets
import socket
from pathlib import Path
from urllib.parse import ParseResult, urlparse

import httpx

from . import config

MAX_UPLOAD_BYTES = 5 * 1024 * 1024       # 5 MB file
MAX_FETCH_BYTES = 2 * 1024 * 1024        # 2 MB web page
FETCH_TIMEOUT_SECONDS = 10.0
MAX_REDIRECTS = 5
MAX_TEXT_CHARS = 60_000                  # kept per attachment
PER_ATTACHMENT_PROMPT_CHARS = 6_000      # sent to the AI per attachment
TOTAL_PROMPT_CHARS = 15_000              # sent to the AI for all attachments
MAX_ATTACHMENTS = 5
TEXT_TYPES = {".txt", ".md", ".csv", ".json", ".tsv", ".log"}


class AttachmentError(ValueError):
    pass


_transport: httpx.AsyncBaseTransport | None = None  # tests swap in a MockTransport


def attachments_dir() -> Path:
    return config.ledger_path().parent / "attachments"


def _clean(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\x00", "")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()[:MAX_TEXT_CHARS]


def text_from_file(name: str, data: bytes) -> str:
    suffix = Path(name).suffix.lower()
    if suffix == ".pdf":
        from pypdf import PdfReader
        from pypdf.errors import PdfReadError

        try:
            reader = PdfReader(io.BytesIO(data))
            pages = [page.extract_text() or "" for page in reader.pages[:200]]
        except (PdfReadError, ValueError, KeyError) as exc:
            raise AttachmentError(f"couldn't read that PDF: {exc}") from exc
        text = "\n\n".join(pages)
        if not text.strip():
            raise AttachmentError("that PDF has no text layer (is it a scan?)")
        return _clean(text)
    if suffix in TEXT_TYPES:
        return _clean(data.decode("utf-8", errors="replace"))
    raise AttachmentError("supported files: PDF, TXT, MD, CSV, TSV, JSON")


def text_from_html(page: str) -> str:
    page = re.sub(r"(?is)<(script|style|noscript|svg|head)[^>]*>.*?</\1>", " ", page)
    page = re.sub(r"(?i)<br\s*/?>|</(p|div|li|h[1-6]|tr|section|article)>", "\n", page)
    page = re.sub(r"<[^>]+>", " ", page)
    return _clean(html.unescape(page))


async def _resolve(host: str, port: int) -> list[str]:
    """Every address `host` resolves to (a seam for tests)."""
    infos = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return [info[4][0] for info in infos]


def _is_public(address: str) -> bool:
    try:
        ip = ipaddress.ip_address(address.split("%", 1)[0])  # drop an IPv6 zone id
    except ValueError:
        return False
    if ip.version == 6 and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return ip.is_global and not ip.is_multicast


async def _check_link(url: str) -> ParseResult:
    """Only public web pages: no file:// and, unless allowed, nothing on this
    computer or the local network (routers, admin pages, this very server)."""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise AttachmentError("links must start with http:// or https://")
    if config.allow_private_links():
        return parsed
    try:
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        addresses = await _resolve(parsed.hostname, port)
    except ValueError as exc:
        raise AttachmentError("that link has a bad port") from exc
    except OSError as exc:
        raise AttachmentError(f"couldn't find {parsed.hostname}") from exc
    if not addresses or not all(_is_public(a) for a in addresses):
        raise AttachmentError(
            "links to this computer or your local network can't be attached "
            "(set ABYSS_ALLOW_PRIVATE_LINKS=1 to allow them)"
        )
    return parsed


async def text_from_url(url: str) -> tuple[str, str]:
    """(title-ish name, text) for a web page."""
    try:
        # Redirects are followed by hand so every hop is checked, not just the first.
        async with httpx.AsyncClient(timeout=FETCH_TIMEOUT_SECONDS, transport=_transport) as client:
            for _ in range(MAX_REDIRECTS + 1):
                parsed = await _check_link(url)
                async with client.stream("GET", url, headers={"User-Agent": "Abyss/1.0 (local research tool)"}) as response:
                    if response.is_redirect:
                        url = str(response.url.join(response.headers["location"]))
                        continue
                    if response.status_code >= 400:
                        raise AttachmentError(f"that page answered {response.status_code}")
                    body = b""
                    async for chunk in response.aiter_bytes():
                        body += chunk
                        if len(body) > MAX_FETCH_BYTES:
                            break
                    content_type = response.headers.get("content-type", "")
                    break
            else:
                raise AttachmentError("that link redirects too many times")
    except httpx.HTTPError as exc:
        raise AttachmentError(f"couldn't fetch that link: {exc}") from exc
    if "pdf" in content_type:
        return parsed.netloc + parsed.path, text_from_file("page.pdf", body)
    page = body.decode("utf-8", errors="replace")
    title = re.search(r"(?is)<title[^>]*>(.*?)</title>", page)
    name = html.unescape(title.group(1)).strip()[:80] if title else parsed.netloc + parsed.path
    text = text_from_html(page) if "<" in page[:2000] else _clean(page)
    if not text:
        raise AttachmentError("that page had no readable text")
    return name or url, text


def save(name: str, kind: str, source: str, text: str) -> dict:
    record = {
        "id": "a_" + secrets.token_hex(6),
        "name": name[:120],
        "kind": kind,
        "source": source[:500],
        "chars": len(text),
        "text": text,
    }
    directory = attachments_dir()
    directory.mkdir(parents=True, exist_ok=True)
    (directory / f"{record['id']}.json").write_text(json.dumps(record), encoding="utf-8")
    return record


def public(record: dict) -> dict:
    return {
        "id": record["id"],
        "name": record["name"],
        "kind": record["kind"],
        "chars": record["chars"],
        "preview": record["text"][:240],
    }


def load(attachment_id: str) -> dict | None:
    if not re.fullmatch(r"a_[0-9a-f]{12}", attachment_id or ""):
        return None
    try:
        return json.loads((attachments_dir() / f"{attachment_id}.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


async def create(body: dict) -> dict:
    """From the page's JSON: {"url": ...} or {"name": ..., "data_base64": ...}."""
    if body.get("url"):
        url = str(body["url"]).strip()
        name, text = await text_from_url(url)
        return save(name, "link", url, text)
    name = str(body.get("name") or "file").strip()
    try:
        data = base64.b64decode(str(body.get("data_base64") or ""), validate=True)
    except (binascii.Error, ValueError) as exc:
        raise AttachmentError("the file didn't upload correctly") from exc
    if not data:
        raise AttachmentError("that file is empty")
    if len(data) > MAX_UPLOAD_BYTES:
        raise AttachmentError("files can be up to 5 MB")
    return save(name, "file", name, text_from_file(name, data))


def context_for(ids: list[str]) -> tuple[str, list[str]]:
    """The reference material to add to work prompts, and the attachments' names."""
    parts: list[str] = []
    names: list[str] = []
    budget = TOTAL_PROMPT_CHARS
    for attachment_id in ids[:MAX_ATTACHMENTS]:
        record = load(attachment_id)
        if record is None or budget <= 0:
            continue
        excerpt = record["text"][: min(PER_ATTACHMENT_PROMPT_CHARS, budget)]
        budget -= len(excerpt)
        cut = "" if len(excerpt) == record["chars"] else f"\n[... cut, {record['chars']:,} characters in total]"
        parts.append(f"### {record['name']} ({record['kind']})\n{excerpt}{cut}")
        names.append(record["name"])
    return "\n\n".join(parts), names
