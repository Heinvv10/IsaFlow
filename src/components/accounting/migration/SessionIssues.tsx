import { AlertCircle } from 'lucide-react';

export interface SessionIssue {
  step: string;
  row?: number;
  field?: string;
  message: string;
  severity?: 'error' | 'warning';
}

/**
 * The session's recorded issues, surviving a page reload.
 *
 * The import steps persist their per-row errors and their `severity: 'warning'`
 * rounding notes onto the session precisely so they outlive the response that
 * carried them. Nothing read them back until this panel: an operator who
 * navigated away from ar-invoices lost the record that a row had imported with
 * drift, which is the one thing R-002 exists to show them.
 */
export default function SessionIssues({ issues }: { issues: SessionIssue[] }) {
  if (issues.length === 0) return null;
  const warnings = issues.filter(i => i.severity === 'warning');
  const errors = issues.filter(i => i.severity !== 'warning');
  const label = (i: SessionIssue) =>
    `${i.step}${i.row !== undefined ? ` row ${i.row + 1}` : ''}: ${i.message}`;
  return (
    <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)]">
      <div className="px-5 py-4 border-b border-[var(--ff-border-light)]">
        <h2 className="font-semibold text-[var(--ff-text-primary)]">Import Issues</h2>
        <p className="text-xs text-[var(--ff-text-secondary)] mt-0.5">
          Recorded by the steps that have run. Re-running a step replaces its own entries.
        </p>
      </div>
      <div className="p-5 space-y-2">
        {warnings.map((w, i) => (
          <div key={`w${i}`} className="flex items-start gap-2 p-3 rounded-lg bg-amber-500/10 text-amber-400 text-sm">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" /> {label(w)}
          </div>
        ))}
        {errors.map((e, i) => (
          <div key={`e${i}`} className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" /> {label(e)}
          </div>
        ))}
      </div>
    </div>
  );
}
