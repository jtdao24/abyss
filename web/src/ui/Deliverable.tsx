import type { AgentSpec, FinalData } from "../contract";
import { VENDOR } from "../scene/model";

interface ResultViewProps {
  final: FinalData;
  agents: Partial<Record<string, AgentSpec>>;
}

/** A finished job: the deliverable, who did each task, grades and costs. */
export function ResultView({ final, agents }: ResultViewProps) {
  return (
    <div className="result-view">
      <p className="deliverable-text">{final.deliverable ?? "No deliverable produced."}</p>
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
        <span>{final.status === "ok" ? "Complete" : final.status}</span>
        <span>Mean grade {final.mean_grade ?? "—"}</span>
        <span>Total ${final.total_cost_usd.toFixed(5)}</span>
        <span>{(final.duration_ms / 1000).toFixed(1)}s</span>
      </footer>
    </div>
  );
}
