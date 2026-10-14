/**
 * The check run sealed with a snapshot: each check's status, how many rows
 * it looked at and its findings — leads to look at, not verdicts.
 */
import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { CheckRun } from './auditSnapshotApi';

const STATUS: Record<string, string> = {
  pass: 'bg-teal-900/50 text-teal-300', fail: 'bg-amber-900/50 text-amber-300', unknown: 'bg-slate-700 text-slate-300',
};
const FAMILY: Record<string, string> = { integrity: 'Integrity', anomaly: 'Anomaly scan', journal_risk: 'Journal risk (leads)' };

export function CheckRunView({ run }: { run: CheckRun }) {
  const [open, setOpen] = useState<string | null>(null);
  const families = ['journal_risk', 'integrity', 'anomaly'];
  return (
    <div className="space-y-5 p-4">
      <p className="text-xs text-slate-500">
        Run over {run.periodStart} to {run.asAt}. A finding is a lead for a person to look at, not a conclusion. &ldquo;unknown&rdquo; means
        the check did not answer — never read it as clean.
      </p>
      {families.map((f) => (
        <div key={f}>
          <h3 className="text-xs uppercase tracking-wider text-slate-400 mb-2">{FAMILY[f]}</h3>
          <div className="divide-y divide-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.06)] rounded-lg">
            {run.results.filter((r) => r.family === f).map((r) => (
              <div key={r.checkId}>
                <button onClick={() => setOpen(open === r.checkId ? null : r.checkId)} disabled={r.findings.length === 0}
                  className="w-full flex items-center gap-3 px-3 py-2 text-left text-sm hover:bg-white/5 disabled:cursor-default">
                  {r.findings.length > 0 ? (open === r.checkId ? <ChevronDown className="h-4 w-4 text-slate-500" /> : <ChevronRight className="h-4 w-4 text-slate-500" />) : <span className="w-4" />}
                  <span className="flex-1 text-slate-200">{r.checkId.replace(/^[a-z_]+\./, '').replace(/_/g, ' ')}</span>
                  <span className="text-xs text-slate-500">{r.population === null ? '' : `${r.population} looked at · `}{r.findingCount} finding{r.findingCount === 1 ? '' : 's'}</span>
                  <span className={`px-2 py-0.5 rounded text-xs ${STATUS[r.status]}`}>{r.status}</span>
                </button>
                {open === r.checkId && (
                  <ul className="px-10 pb-3 space-y-1 text-xs">
                    {r.findings.map((x) => (
                      <li key={x.key} className="text-slate-300">
                        {Object.entries(x.detail).filter(([, v]) => v !== null && v !== '').map(([k, v]) => `${k.replace(/_/g, ' ')}: ${String(v)}`).join(' · ')}
                        <span className="block font-mono text-slate-600">{x.refs.slice(0, 4).join(', ')}{x.refs.length > 4 ? ` +${x.refs.length - 4}` : ''}</span>
                      </li>
                    ))}
                    {r.findingCount > r.findings.length && <li className="text-slate-500">…and {r.findingCount - r.findings.length} more</li>}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
