from __future__ import annotations

import base64
import importlib

import pytest
from fastapi.testclient import TestClient

from abyss import attachments
from abyss.agents import build_work_prompt
from abyss.orchestrator import TaskSpec


def tiny_pdf(text: str) -> bytes:
    """A minimal one-page PDF with `text` in Helvetica (valid xref offsets)."""
    stream = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode()
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = b"%PDF-1.4\n"
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    out += b"".join(f"{offset:010d} 00000 n \n".encode() for offset in offsets)
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return out


@pytest.fixture
def server(monkeypatch, tmp_path):
    monkeypatch.setenv("ABYSS_FAKE_LLM", "1")
    monkeypatch.setenv("ABYSS_FAKE_DELAY", "0")
    monkeypatch.setenv("ABYSS_LEDGER_PATH", str(tmp_path / "ledger.jsonl"))
    monkeypatch.setenv("ABYSS_REP_PATH", str(tmp_path / "reputation.json"))
    monkeypatch.setenv("ABYSS_SESSIONS_DIR", str(tmp_path / "sessions"))
    import abyss.server

    return importlib.reload(abyss.server)


def test_text_files_and_pdfs_become_plain_text() -> None:
    assert attachments.text_from_file("notes.md", b"# Tides\r\n\r\n\r\n\r\nTwo a day.") == "# Tides\n\nTwo a day."
    assert "moon,0.46" in attachments.text_from_file("data.csv", b"body,ratio\nmoon,0.46\n")
    assert "Tides come twice a day" in attachments.text_from_file("paper.pdf", tiny_pdf("Tides come twice a day"))
    with pytest.raises(attachments.AttachmentError):
        attachments.text_from_file("photo.png", b"\x89PNG")
    with pytest.raises(attachments.AttachmentError):
        attachments.text_from_file("broken.pdf", b"not a pdf")


def test_web_pages_lose_their_markup() -> None:
    page = "<html><head><title>T</title><style>p{}</style></head><body><script>x()</script><h1>Tides</h1><p>Two &amp; a day</p></body></html>"
    text = attachments.text_from_html(page)
    assert "Tides" in text and "Two & a day" in text
    assert "x()" not in text and "p{}" not in text and "<" not in text


async def test_only_web_links_are_fetched() -> None:
    for url in ("file:///etc/passwd", "ftp://example.com/x", "not a url"):
        with pytest.raises(attachments.AttachmentError):
            await attachments.text_from_url(url)


def test_material_reaches_the_work_prompt_capped(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("ABYSS_LEDGER_PATH", str(tmp_path / "ledger.jsonl"))
    small = attachments.save("notes.md", "file", "notes.md", "The Sun adds 46%.")
    big = attachments.save("book.txt", "file", "book.txt", "x" * 20_000)
    context, names = attachments.context_for([small["id"], big["id"], "a_000000000000"])
    assert names == ["notes.md", "book.txt"]  # an unknown id is skipped
    assert "The Sun adds 46%." in context and "cut, 20,000 characters in total" in context
    assert len(context) < attachments.TOTAL_PROMPT_CHARS + 500
    task = TaskSpec(task_id="t1", type="research", title="Facts", brief="Find facts.", depends_on=[])
    _, user = build_work_prompt("Explain tides.", task, {}, None, context)
    assert "Reference material the client attached" in user and "The Sun adds 46%." in user
    _, plain = build_work_prompt("Explain tides.", task, {})
    assert "Reference material" not in plain


def test_upload_attach_and_start_a_session(server) -> None:
    with TestClient(server.app) as client:
        pdf = base64.b64encode(tiny_pdf("Spring tides at full moon")).decode()
        added = client.post("/api/attachments", json={"name": "tides.pdf", "data_base64": pdf}).json()
        assert added["id"].startswith("a_") and "Spring tides" in added["preview"]
        assert client.post("/api/attachments", json={"name": "x.exe", "data_base64": pdf}).status_code == 400
        assert client.post("/api/attachments", json={"url": "file:///etc/passwd"}).status_code == 400

        with client.websocket_connect("/ws") as ws:
            ws.receive_json()
            ws.send_json({"type": "start_job", "job": "Explain tides.", "attachments": ["a_ffffffffffff"]})
            assert "attachment is missing" in ws.receive_json()["data"]["message"]
            ws.send_json({"type": "start_job", "job": "Explain tides.", "attachments": [added["id"]]})
            assert ws.receive_json()["type"] == "job_split"
            while ws.receive_json()["type"] != "final":
                pass
        assert client.get("/api/sessions").json()[0]["attachments"] == ["tides.pdf"]


def test_vendor_stats_add_up_across_sessions(server) -> None:
    with TestClient(server.app) as client:
        with client.websocket_connect("/ws") as ws:
            ws.receive_json()
            for _ in range(2):
                ws.send_json({"type": "start_job", "job": "Explain tides, then check it."})
                while ws.receive_json()["type"] != "final":
                    pass
        stats = client.get("/api/vendors").json()
    vendors = stats["vendors"]
    assert stats["sessions"] == 2
    total_wins = sum(v["wins"] for v in vendors.values())
    assert total_wins == 6  # 3 tasks x 2 sessions, one winner each
    # The two cheaper vendors bid on every task; the premium one is a backup and
    # stays on standby while they're trusted (a standby isn't a bid).
    assert vendors["haiku"]["bids"] == 6 and vendors["sonnet"]["bids"] == 6
    assert vendors["opus"]["bids"] == 0 and vendors["opus"]["wins"] == 0
    for v in vendors.values():
        if v["wins"]:
            assert 0 < v["win_rate"] <= 1 and 1 <= v["avg_grade"] <= 10
            assert sum(len(points) for points in v["history"].values()) == v["wins"]
        assert set(v["reputation"]) == {"research", "writing", "checking"}
