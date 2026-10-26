/**
 * One audit snapshot (forensic-controls step 4): its seal and caveat, Verify,
 * and tabs for the frozen trial balance, journals, the check run, and
 * "Compare to today". Owner / admin / manager (the routes refuse anyone else).
 * Reached from Accounting → Evidence Packs.
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { ArrowLeft, Camera, Loader2, ShieldCheck, AlertCircle } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiErrorMessage } from '@/lib/apiFetch';
import {
  TRIGGER_LABEL, fmtAmount, fmtAt, getData, type CheckRun, type Comparison, type Row, type SnapshotSummary, type Verification,
} from '@/components/accounting/audit/auditSnapshotApi';
import { SnapshotJournals } from '@/components/accounting/audit/SnapshotJournals';
import { CheckRunView } from '@/components/accounting/audit/CheckRunView';
import { ComparisonView } from '@/components/accounting/audit/ComparisonView';

type Tab = 'tb' | 'journals' | 'checks' | 'compare';
const TABS: [Tab, string][] = [['tb', 'Trial balance'], ['journals', 'Journals'], ['checks', 'Checks'], ['compare', 'Compare to today']];

export default function AuditSnapshotPage() {
  const id = String(useRouter().query.id ?? '');
  const [snap, setSnap] = useState<SnapshotSummary | null>(null);
  const [run, setRun] = useState<CheckRun | null>(null);
  const [tb, setTb] = useState<{ accountId: string; row: Row }[]>([]);
  const [tab, setTab] = useState<Tab>('tb');
  const [error, setError] = useState('');
  const [verification, setVerification] = useState<Verification | null>(null);
  const [cmp, setCmp] = useState<Comparison | null>(null);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    if (!id) return;
    setError('');
    try {
      const d = await getData<{ snapshot: SnapshotSummary; checkRun: CheckRun | null }>(`/api/accounting/audit-snapshots?id=${id}`, 'Could not load the snapshot - try again');
      setSnap(d.snapshot); setRun(d.checkRun);
      setTb((await getData<{ rows: { accountId: string; row: Row }[] }>(`/api/accounting/audit-snapshots?id=${id}&section=tb`, 'Could not load the trial balance - try again')).rows);
    } catch (err) { setError(apiErrorMessage(err, 'Could not load the snapshot - try again')); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  async function verify() {
    setBusy('verify');
    try { setVerification((await getData<{ verification: Verification }>(`/api/accounting/audit-snapshots?id=${id}&verify=1`, 'Could not verify - try again')).verification); }
    catch (err) { setError(apiErrorMessage(err, 'Could not verify - try again')); }
    finally { setBusy(''); }
  }
  async function compare() {
    setTab('compare'); setBusy('compare');
    try { setCmp((await getData<{ comparison: Comparison }>(`/api/accounting/audit-comparisons?snapshotId=${id}`, 'Could not compare - try again')).comparison); }
    catch (err) { setError(apiErrorMessage(err, 'Could not compare - try again')); }
    finally { setBusy(''); }
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)] px-6 py-5 space-y-4">
        <Link href="/accounting/audit-packs" className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200"><ArrowLeft className="h-3.5 w-3.5" />Evidence Packs</Link>
        {error && <div className="flex items-center gap-2 text-red-400 text-sm"><AlertCircle className="h-4 w-4" />{error}</div>}
        {!snap && !error && <Loader2 className="h-6 w-6 animate-spin text-teal-500" />}
        {snap && (
          <>
            <div className="bg-[var(--ff-canvas-mid)] border border-[rgba(255,255,255,0.08)] rounded-xl p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <h1 className="text-xl font-semibold text-[var(--ff-text-primary)] flex items-center gap-2"><Camera className="h-5 w-5 text-teal-400" />Audit snapshot — cutoff {snap.cutoff}</h1>
                  <p className="text-sm text-slate-400 mt-1">{TRIGGER_LABEL[snap.trigger] ?? snap.trigger} · taken {fmtAt(snap.takenAt)} by {snap.takenByName ?? snap.takenBy} ({snap.channel})</p>
                  <p className="text-xs text-slate-500 mt-1">{String(snap.totals.journal_count ?? 0)} journals · {String(snap.totals.line_count ?? 0)} lines · debits {fmtAmount(String(snap.totals.total_debit ?? '0'))} · credits {fmtAmount(String(snap.totals.total_credit ?? '0'))}</p>
                  <p className="text-xs font-mono text-slate-500 mt-2 break-all">SHA-256 {snap.canonicalHash ?? '—'} · key {snap.keyId ?? '—'}</p>
                  <p className="text-xs text-amber-200/80 mt-2 max-w-3xl">{snap.caveat}</p>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => void verify()} disabled={!!busy || snap.status !== 'sealed'} className="inline-flex items-center gap-2 px-3 py-2 rounded bg-white/5 hover:bg-white/10 text-slate-200 text-sm disabled:opacity-50">
                    {busy === 'verify' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} Verify
                  </button>
                  <button onClick={() => void compare()} disabled={!!busy || snap.status !== 'sealed'} className="px-3 py-2 rounded bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium disabled:opacity-50">Compare to today</button>
                </div>
              </div>
              {verification && (
                <p className={`mt-3 text-sm ${verification.status === 'valid' ? 'text-teal-300' : 'text-red-400'}`}>
                  {verification.status === 'valid' ? 'Seal valid' : `Verification: ${verification.status}`} — recomputed from {verification.rowsChecked.accounts} accounts,
                  {' '}{verification.rowsChecked.journals} journals and {verification.rowsChecked.lines} lines{verification.rowMismatchCount ? `; ${verification.rowMismatchCount} rows do not match their hash` : ''}.
                </p>
              )}
              {snap.failureReason && <p className="mt-3 text-sm text-red-400">This attempt failed: {snap.failureReason}</p>}
            </div>
            <div className="bg-[var(--ff-canvas-mid)] border border-[rgba(255,255,255,0.08)] rounded-xl overflow-hidden">
              <div className="flex border-b border-[rgba(255,255,255,0.06)]">
                {TABS.map(([t, label]) => (
                  <button key={t} onClick={() => (t === 'compare' ? void compare() : setTab(t))}
                    className={`px-4 py-2.5 text-sm ${tab === t ? 'text-teal-300 border-b-2 border-teal-400' : 'text-slate-400 hover:text-slate-200'}`}>{label}</button>
                ))}
              </div>
              {tab === 'tb' && (
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-xs text-slate-500 uppercase tracking-wider"><th className="px-4 py-2">Account</th><th className="px-4 py-2">Type</th>
                    <th className="px-4 py-2 text-right">Opening</th><th className="px-4 py-2 text-right">Debit</th><th className="px-4 py-2 text-right">Credit</th><th className="px-4 py-2 text-right">Closing</th></tr></thead>
                  <tbody className="divide-y divide-[rgba(255,255,255,0.04)]">{tb.map(({ accountId, row }) => (
                    <tr key={accountId} className="text-slate-300"><td className="px-4 py-1.5">{row.account_code} {row.account_name}</td><td className="px-4 py-1.5 text-slate-500">{row.account_type}</td>
                      {(['opening', 'debit', 'credit', 'closing'] as const).map((k) => <td key={k} className="px-4 py-1.5 text-right">{fmtAmount(row[k])}</td>)}</tr>
                  ))}</tbody>
                </table>
              )}
              {tab === 'journals' && <SnapshotJournals snapshotId={id} />}
              {tab === 'checks' && (run ? <CheckRunView run={run} /> : <p className="p-4 text-sm text-slate-500">No check run.</p>)}
              {tab === 'compare' && (busy === 'compare' ? <div className="p-6"><Loader2 className="h-5 w-5 animate-spin text-teal-500" /></div> : cmp && <ComparisonView c={cmp} />)}
            </div>
          </>
        )}
      </div>
    </AppLayout>
  );
}
