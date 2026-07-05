/**
 * Loan Compliance Tab — NCA in-duplum + IFRS 9 ECL staging.
 */

import { useState, useEffect, useCallback } from 'react';
import { AlertTriangle, ShieldCheck, Loader2, Play } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { fmt, fmtDate } from '@/components/loans/types';

interface Assessment {
  id: string;
  assessmentDate: string;
  ncaFlagged: boolean;
  ncaPeriod: number | null;
  stage: 1 | 2 | 3 | null;
  daysPastDue: number;
  eclAmount: number;
  eclMethod: '12m' | 'lifetime' | 'full' | null;
  outstanding: number | null;
  assessedAt: string;
}

const STAGE_COLOURS: Record<string, string> = {
  '1': 'bg-teal-500/10 text-teal-400 border-teal-500/30',
  '2': 'bg-amber-500/10 text-amber-400 border-amber-500/30',
  '3': 'bg-red-500/10 text-red-400 border-red-500/30',
};

const STAGE_LABELS: Record<string, string> = {
  '1': 'Stage 1 — Performing',
  '2': 'Stage 2 — Under-performing',
  '3': 'Stage 3 — Impaired',
};

interface Props { loanId: string }

export function LoanComplianceTab({ loanId }: Props) {
  const [history, setHistory] = useState<Assessment[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/accounting/loans/${loanId}/compliance`, { credentials: 'include' });
      const json = await res.json();
      setHistory(json.data ?? []);
    } catch (err) {
      setHistory([]);
      setError(err instanceof Error ? err.message : 'Failed to load compliance history');
    }
    setLoading(false);
  }, [loanId]);


  useEffect(() => { void load(); }, [load]);

  const runAssessment = async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/accounting/loans/${loanId}/compliance`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: 'Assessment failed' }));
        setError(err.message ?? 'Assessment failed');
      } else {
        await load();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Assessment failed');
    }
    setRunning(false);
  };

  const latest = history[0];

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">Compliance Assessment</h2>
        <button
          onClick={runAssessment}
          disabled={running}
          className="flex items-center gap-2 rounded-lg bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-50"
        >
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          Run Assessment
        </button>
      </div>

      {error && (
        <div className="rounded-lg bg-red-500/10 border border-red-500/30 p-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-teal-500" />
        </div>
      )}

      {!loading && latest && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className={`rounded-xl border p-4 ${latest.ncaFlagged ? 'bg-red-500/10 border-red-500/30' : 'bg-teal-500/10 border-teal-500/30'}`}>
            <div className="flex items-center gap-2 mb-2">
              {latest.ncaFlagged
                ? <AlertTriangle className="h-4 w-4 text-red-400" />
                : <ShieldCheck className="h-4 w-4 text-teal-400" />
              }
              <span className={`text-sm font-medium ${latest.ncaFlagged ? 'text-red-400' : 'text-teal-400'}`}>
                NCA In-Duplum
              </span>
            </div>
            <p className={`text-xs ${latest.ncaFlagged ? 'text-red-300' : 'text-teal-300'}`}>
              {latest.ncaFlagged
                ? `Cap breached at period ${latest.ncaPeriod ?? '?'}. Interest posting will be blocked.`
                : 'Compliant — cumulative interest below original principal.'
              }
            </p>
          </div>

          <div className={`rounded-xl border p-4 ${STAGE_COLOURS[String(latest.stage ?? 1)]}`}>
            <div className="text-xs font-medium mb-1">IFRS 9 Stage</div>
            <div className="text-lg font-semibold">{STAGE_LABELS[String(latest.stage ?? 1)]}</div>
            <div className="mt-2 text-xs space-y-0.5">
              <div>DPD: <span className="font-mono">{latest.daysPastDue}</span></div>
              <div>ECL: <span className="font-mono">{fmt(latest.eclAmount)}</span> <span className="opacity-60">({latest.eclMethod ?? '—'})</span></div>
              <div>Outstanding: <span className="font-mono">{latest.outstanding != null ? fmt(latest.outstanding) : '—'}</span></div>
            </div>
          </div>
        </div>
      )}

      {!loading && history.length === 0 && (
        <div className="flex flex-col items-center justify-center py-12 text-[var(--ff-text-tertiary)]">
          <ShieldCheck className="h-8 w-8 mb-2" />
          <p className="text-sm">No compliance assessments yet.</p>
          <p className="text-xs mt-1">Click &ldquo;Run Assessment&rdquo; to evaluate NCA and IFRS 9 status.</p>
        </div>
      )}

      {history.length > 1 && (
        <div>
          <h3 className="text-xs font-semibold text-[var(--ff-text-tertiary)] uppercase tracking-wide mb-2">History</h3>
          <div className="rounded-xl border border-[var(--ff-border-light)] overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-[var(--ff-bg-primary)]">
                <tr className="text-left text-[var(--ff-text-tertiary)]">
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 font-medium">Stage</th>
                  <th className="px-3 py-2 font-medium">DPD</th>
                  <th className="px-3 py-2 font-medium text-right">ECL</th>
                  <th className="px-3 py-2 font-medium text-right">Outstanding</th>
                  <th className="px-3 py-2 font-medium">NCA</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--ff-border-light)]">
                {history.map(a => (
                  <tr key={a.id} className="hover:bg-[var(--ff-bg-primary)]">
                    <td className="px-3 py-2 text-[var(--ff-text-primary)]">{fmtDate(a.assessmentDate)}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-xs border ${STAGE_COLOURS[String(a.stage ?? 1)]}`}>
                        {a.stage ?? '—'}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-[var(--ff-text-primary)] font-mono">{a.daysPastDue}</td>
                    <td className="px-3 py-2 text-right text-[var(--ff-text-primary)] font-mono">{fmt(a.eclAmount)}</td>
                    <td className="px-3 py-2 text-right text-[var(--ff-text-primary)] font-mono">{a.outstanding != null ? fmt(a.outstanding) : '—'}</td>
                    <td className="px-3 py-2">
                      {a.ncaFlagged
                        ? <span className="text-red-400 text-xs">⚠ Breach</span>
                        : <span className="text-teal-400 text-xs">OK</span>
                      }
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
