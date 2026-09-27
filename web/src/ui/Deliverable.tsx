import { useState } from "react";

import type { FinalData } from "../contract";
import { VENDOR } from "../scene/model";

/** Save the finished file from the browser (no terminal needed). */
function download(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/** A finished job: the Captain's file, who did each task, grades and costs. */
export function ResultView({ final }: { final: FinalData }) {
  const [copied, setCopied] = useState(false);
  const text = final.deliverable;
  return (
    <div className="result-view">
      {final.filename && <p className="file-name">📄 {final.filename}</p>}
      {text && (
        <div className="result-actions">
          <button type="button" onClick={() => download(final.filename ?? "result.md", text)}>Download</button>
          <button
            type="button"
            onClick={() => {
              navigator.clipboard?.writeText(text).then(
                () => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                },
                () => undefined,
              );
            }}
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
      )}
      {final.summary && <p className="rpg-hint">{final.summary}</p>}
      <pre className="deliverable-text">{text ?? "No deliverable produced."}</pre>
      <table>
        <thead>
          <tr><th>Task</th><th>Vendor</th><th>Grade / promised</th><th>Cost</th></tr>
        </thead>
        <tbody>
          {final.tasks.map((task) => (
            <tr key={task.task_id}>
              <td>{task.task_id} · {task.type}</td>
              <td style={{ color: task.agent_id ? VENDOR[task.agent_id].color : undefined }}>
                {task.agent_id ? VENDOR[task.agent_id].name : "—"}
              </td>
              <td>{task.grade ?? "—"} / {task.promised_quality ?? "—"}</td>
              <td>${task.cost_usd.toFixed(5)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <footer>
        <span>{final.status === "ok" ? "Complete" : final.status === "partial" ? "Partial (stopped early)" : final.status}</span>
        <span>Mean grade {final.mean_grade ?? "—"}</span>
        <span>Total ${final.total_cost_usd.toFixed(5)}</span>
        <span>{(final.duration_ms / 1000).toFixed(1)}s</span>
      </footer>
    </div>
  );
}
