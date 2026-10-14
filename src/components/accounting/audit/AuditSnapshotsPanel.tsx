/**
 * Audit snapshots on the Evidence Packs page (forensic-controls step 4): the
 * company's sealed snapshots and failed automatic attempts, "Take snapshot"
 * at a cutoff (owner / admin), Verify, open the detail, build a pack from one.
 * A role that may not read them sees the server's refusal, nothing else.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Camera, Loader2, ShieldCheck, ShieldAlert, Package, AlertCircle } from 'lucide-react';
import { apiErrorMessage } from '@/lib/apiFetch';
import { localISODate } from '@/lib/dateUtils';
import { TRIGGER_LABEL, fmtAt, getData, type SnapshotSummary, type Verification } from './auditSnapshotApi';

interface Props { onPackBuilt: () => void; notify: (msg: string, ok?: boolean) => void }

const VERDICT: Record<Verification['status'], { text: string; cls: string }> = {
  valid: { text: 'Seal valid', cls: 'text-teal-300' },
  invalid: { text: 'INVALID — the stored snapshot does not match its seal', cls: 'text-red-400' },
  not_sealed: { text: 'Not sealed (failed attempt)', cls: 'text-slate-400' },
  unchanged: { text: 'Unchanged — verify the snapshot it points to', cls: 'text-slate-400' },
};

/** A close or VAT lock with no snapshot recorded after it; `pending` while its automatic snapshot may still be running. */
interface Unrecorded { trigger: string; cutoff: string; lockedAt: string; pending?: boolean }

interface ChainResult {
  status: 'valid' | 'broken' | 'empty'; length: number; breaks: { seq: number | null; reason: string }[];
  forged?: { seq: number }[];
  restarts?: { seq: number }[];
}

export function AuditSnapshotsPanel({ onPackBuilt, notify }: Props) {
  const [rows, setRows] = useState<SnapshotSummary[]>([]);
  const [unrecorded, setUnrecorded] = useState<Unrecorded[]>([]);
  const lost = unrecorded.filter((u) => !u.pending);
  const pending = unrecorded.filter((u) => u.pending);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [cutoff, setCutoff] = useState(() => localISODate(new Date(new Date().getFullYear(), new Date().getMonth(), 0)));
  const [busy, setBusy] = useState<string | null>(null);
  const [verdicts, setVerdicts] = useState<Record<string, Verification['status']>>({});
  const [chain, setChain] = useState<ChainResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const d = await getData<{ snapshots?: SnapshotSummary[]; unrecorded?: Unrecorded[] }>('/api/accounting/audit-snapshots', 'Could not load the audit snapshots - try again');
      if (!Array.isArray(d?.snapshots)) throw new Error('unexpected response');
      setRows(d.snapshots);
      setUnrecorded(d.unrecorded ?? []);
    } catch (err) { setRows([]); setError(apiErrorMessage(err, 'Could not load the audit snapshots - try again')); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function take() {
    setBusy('take');
    try {
      const out = await getData<{ snapshot: { lines: number; durationMs: number } }>('/api/accounting/audit-snapshots',
        'Could not take the snapshot - try again', { method: 'POST', body: JSON.stringify({ cutoff }) });
      notify(`Snapshot sealed — ${out.snapshot.lines} journal lines in ${(out.snapshot.durationMs / 1000).toFixed(1)} s`);
      void load();
    } catch (err) { notify(apiErrorMessage(err, 'Could not take the snapshot - try again'), false); }
    finally { setBusy(null); }
  }

  async function verify(id: string) {
    setBusy(`verify:${id}`);
    try {
      const v = await getData<{ verification: Verification }>(`/api/accounting/audit-snapshots?id=${id}&verify=1`, 'Could not verify the snapshot - try again');
      setVerdicts((p) => ({ ...p, [id]: v.verification.status }));
    } catch (err) { notify(apiErrorMessage(err, 'Could not verify the snapshot - try again'), false); }
    finally { setBusy(null); }
  }

  async function verifyChain() {
    setBusy('chain');
    try {
      setChain((await getData<{ chain: ChainResult }>('/api/accounting/audit-snapshots?chain=1', 'Could not check the chain - try again')).chain);
    } catch (err) { notify(apiErrorMessage(err, 'Could not check the chain - try again'), false); }
    finally { setBusy(null); }
  }

  async function buildPack(s: SnapshotSummary) {
    setBusy(`pack:${s.id}`);
    try {
      const periodStart = String(s.totals.fy_start ?? s.cutoff);
      await getData('/api/accounting/audit-exports', 'Could not build the audit pack - try again',
        { method: 'POST', body: JSON.stringify({ periodStart, snapshotId: s.id, includeComparison: true }) });
      notify('Pack built from the snapshot');
      onPackBuilt();
    } catch (err) { notify(apiErrorMessage(err, 'Could not build the audit pack - try again'), false); }
    finally { setBusy(null); }
  }

  return (
    <div className="bg-[var(--ff-canvas-mid)] border border-[rgba(255,255,255,0.08)] rounded-xl overflow-hidden mb-6">
      <div className="px-6 py-4 border-b border-[rgba(255,255,255,0.06)] flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-[var(--ff-text-primary)] flex items-center gap-2">
            <Camera className="h-4 w-4 text-teal-400" /> Audit snapshots
          </h2>
          <p className="text-xs text-[var(--ff-text-secondary)] mt-0.5 max-w-2xl">
            A sealed freeze of the books at a cutoff date. Taken by hand, and automatically when a period, a VAT period or a year is closed.
            Compare one with today&rsquo;s books to see what changed behind it.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <div>
            <label htmlFor="audit-snapshot-cutoff" className="text-xs text-slate-400 mb-1 block">Cutoff</label>
            <input id="audit-snapshot-cutoff" type="date" value={cutoff} onChange={(e) => setCutoff(e.target.value)}
              className="px-3 py-1.5 rounded bg-white/5 border border-[rgba(255,255,255,0.1)] text-slate-200 text-sm" />
          </div>
          <button onClick={() => void verifyChain()} disabled={busy !== null}
            className="px-3 py-2 rounded bg-white/5 hover:bg-white/10 text-slate-200 text-sm">
            {busy === 'chain' ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Verify chain'}
          </button>
          <button onClick={() => void take()} disabled={busy !== null || !cutoff}
            className="inline-flex items-center gap-2 px-3 py-2 rounded bg-teal-600 hover:bg-teal-500 text-white text-sm font-medium disabled:opacity-60">
            {busy === 'take' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />} Take snapshot
          </button>
        </div>
      </div>
      {chain && (
        <div className={`px-6 py-2 border-b border-[rgba(255,255,255,0.06)] text-xs ${chain.status === 'broken' ? 'text-red-400' : chain.status === 'valid' ? 'text-teal-300' : 'text-slate-400'}`}>
          {chain.status === 'valid' && (chain.restarts?.length ?? 0) === 0 && `Chain intact: ${chain.length} sealed snapshots, each naming the one before.`}
          {chain.status === 'valid' && (chain.restarts?.length ?? 0) > 0 && (
            <span className="text-amber-300">{`Chain restarts at ${chain.restarts!.map((r) => `#${r.seq}`).join(', ')}: ${chain.length} sealed snapshots link up from there, after rows that do not verify.`}</span>
          )}
          {chain.status === 'empty' && 'No sealed snapshots yet.'}
          {chain.status === 'broken' && `CHAIN BROKEN: ${chain.breaks.map((b) => `#${b.seq ?? '?'} ${b.reason}`).join('; ')}`}
          {(chain.forged?.length ?? 0) > 0 && (
            <span className="block text-amber-300">
              {`${chain.forged!.length} sealed row(s) do not verify — written without the signing key — and are not part of the chain: ${chain.forged!.map((f) => `#${f.seq}`).join(', ')}.`}
            </span>
          )}
        </div>
      )}
      {lost.length > 0 && (
        <div className="px-6 py-3 border-b border-[rgba(255,255,255,0.06)] text-xs text-amber-300">
          No snapshot was recorded after {lost.length === 1 ? 'this lock' : `these ${lost.length} locks`} (the automatic snapshot was lost — take one by hand):{' '}
          {lost.map((u) => `${TRIGGER_LABEL[u.trigger] ?? u.trigger} ${u.cutoff} (${fmtAt(u.lockedAt)})`).join(' · ')}
        </div>
      )}
      {pending.length > 0 && (
        <div className="px-6 py-3 border-b border-[rgba(255,255,255,0.06)] text-xs text-slate-400">
          Automatic snapshot in progress for {pending.map((u) => `${TRIGGER_LABEL[u.trigger] ?? u.trigger} ${u.cutoff}`).join(' · ')} — refresh in a minute.
        </div>
      )}
      {loading ? (
        <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-teal-500" /></div>
      ) : error ? (
        <div className="flex items-center gap-2 text-red-400 py-8 justify-center text-sm"><AlertCircle className="h-4 w-4" />{error}</div>
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-slate-500">No snapshots yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 uppercase tracking-wider border-b border-[rgba(255,255,255,0.06)]">
              <th className="px-6 py-2 font-medium">Cutoff</th><th className="px-6 py-2 font-medium">Taken</th>
              <th className="px-6 py-2 font-medium">Trigger</th><th className="px-6 py-2 font-medium">Status</th>
              <th className="px-6 py-2 font-medium">Hash</th><th className="px-6 py-2 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[rgba(255,255,255,0.04)]">
            {rows.map((s) => (
              <tr key={s.id} className="hover:bg-white/5 align-top">
                <td className="px-6 py-2 text-slate-200">{s.cutoff}</td>
                <td className="px-6 py-2 text-slate-300">{fmtAt(s.takenAt)}<p className="text-xs text-slate-500">{s.takenByName ?? s.takenBy} · {s.channel}</p></td>
                <td className="px-6 py-2 text-slate-300">{TRIGGER_LABEL[s.trigger] ?? s.trigger}</td>
                <td className="px-6 py-2">
                  {s.status === 'sealed'
                    ? <span className="inline-flex items-center gap-1 text-teal-300 text-xs"><ShieldCheck className="h-3.5 w-3.5" />sealed #{s.seq}</span>
                    : s.status === 'unchanged'
                      ? <Link href={`/accounting/audit-snapshots/${s.sameAsSnapshotId}`} className="text-xs text-slate-300 underline">unchanged since an earlier snapshot</Link>
                      : <span className="inline-flex items-center gap-1 text-red-300 text-xs" title={s.failureReason ?? ''}><ShieldAlert className="h-3.5 w-3.5" />failed</span>}
                  {s.failureReason && <p className="text-xs text-red-400 mt-0.5 max-w-[260px]">{s.failureReason}</p>}
                  {verdicts[s.id] && <p className={`text-xs mt-0.5 ${VERDICT[verdicts[s.id]!].cls}`}>{VERDICT[verdicts[s.id]!].text}</p>}
                </td>
                <td className="px-6 py-2 font-mono text-xs text-slate-500" title={s.canonicalHash ?? ''}>{s.canonicalHash ? `${s.canonicalHash.slice(0, 12)}…` : '—'}</td>
                <td className="px-6 py-2">
                  {s.status === 'sealed' && (
                    <div className="flex items-center gap-2 justify-end text-xs">
                      <button onClick={() => void verify(s.id)} disabled={busy !== null} className="px-2 py-1 rounded bg-white/5 hover:bg-white/10 text-slate-200">
                        {busy === `verify:${s.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Verify'}
                      </button>
                      <Link href={`/accounting/audit-snapshots/${s.id}`} className="px-2 py-1 rounded bg-white/5 hover:bg-white/10 text-teal-300">Open</Link>
                      <button onClick={() => void buildPack(s)} disabled={busy !== null} title="Build an evidence pack from this snapshot"
                        className="px-2 py-1 rounded bg-white/5 hover:bg-white/10 text-slate-200 inline-flex items-center gap-1">
                        {busy === `pack:${s.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Package className="h-3.5 w-3.5" />} Pack
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
