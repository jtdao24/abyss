// The finished file, readable: rendered Markdown (or plain text for code and
// data files), with Copy and Download. A modal over the whole page, so it has
// room on a phone too; Esc, the × or a click outside closes it.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { isMarkdownFile, Markdown } from "./markdown";
import { closeResult, copyText, downloadText, onResultChange, currentResult, type ResultDoc } from "./resultView";

export function ResultPanel() {
  const [doc, setDoc] = useState<ResultDoc | null>(currentResult());
  useEffect(() => onResultChange(setDoc), []);
  if (!doc) return null;
  return createPortal(<ResultDialog key={`${doc.filename}-${doc.costUsd}-${doc.content.length}`} doc={doc} />, document.body);
}

function ResultDialog({ doc }: { doc: ResultDoc }) {
  const markdown = isMarkdownFile(doc.filename);
  const [raw, setRaw] = useState(!markdown);
  const [copied, setCopied] = useState<"ok" | "failed" | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeResult();
      }
      if (e.key === "Tab" && dialogRef.current) {
        // keep focus inside the dialog
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>("button, a[href], [tabindex]:not([tabindex='-1'])");
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      before?.focus?.();
    };
  }, []);

  const copy = async () => {
    setCopied((await copyText(doc.content)) ? "ok" : "failed");
    window.setTimeout(() => setCopied(null), 1600);
  };
  const words = doc.content.trim() ? doc.content.trim().split(/\s+/).length : 0;
  const badge = doc.stopped ? { text: "Stopped", tone: "stopped" } : doc.status === "ok" ? null : { text: "Partial", tone: "partial" };

  return (
    <div className="result-backdrop" onPointerDown={(e) => e.target === e.currentTarget && closeResult()}>
      <div className="result-panel" role="dialog" aria-modal="true" aria-labelledby="result-title" ref={dialogRef}>
        <header className="rp-head">
          <div className="rp-title">
            <span className="rp-icon" aria-hidden="true">
              <svg viewBox="0 0 16 16" width="16" height="16"><path d="M3 1.5h6.5L13 5v9.5H3z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /><path d="M9.5 1.5V5H13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /></svg>
            </span>
            <h1 id="result-title">{doc.filename}</h1>
            {badge && <em className={`rp-badge ${badge.tone}`}>{badge.text}</em>}
          </div>
          <button type="button" className="rp-close" onClick={closeResult} aria-label="Close" ref={closeRef}>×</button>
        </header>
        {(doc.summary || doc.stopped) && (
          <p className="rp-summary">
            {doc.stopped ? "You stopped this job, so this file has what was finished. " : ""}
            {doc.summary}
          </p>
        )}
        <div className="rp-bar">
          <dl className="rp-meta">
            <div><dt>Grade</dt><dd>{doc.meanGrade != null ? `${doc.meanGrade}/10` : "—"}</dd></div>
            <div><dt>Cost</dt><dd>${doc.costUsd.toFixed(4)}</dd></div>
            <div><dt>Time</dt><dd>{(doc.durationMs / 1000).toFixed(1)}s</dd></div>
            <div><dt>Words</dt><dd>{words.toLocaleString()}</dd></div>
          </dl>
          <div className="rp-actions">
            {markdown && (
              <div className="rp-toggle" role="group" aria-label="View">
                <button type="button" aria-pressed={!raw} onClick={() => setRaw(false)}>Formatted</button>
                <button type="button" aria-pressed={raw} onClick={() => setRaw(true)}>Raw</button>
              </div>
            )}
            <button type="button" className="rp-btn" onClick={copy} aria-live="polite">
              {copied === "ok" ? "Copied ✓" : copied === "failed" ? "Couldn't copy" : "Copy"}
            </button>
            <button type="button" className="rp-btn primary" onClick={() => downloadText(doc.filename, doc.content)}>
              Download
            </button>
          </div>
        </div>
        <div className="rp-body" tabIndex={0} aria-label="File contents">
          {raw ? <pre className="rp-raw">{doc.content}</pre> : <article className="md"><Markdown source={doc.content} /></article>}
        </div>
      </div>
    </div>
  );
}
