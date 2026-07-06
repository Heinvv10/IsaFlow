/**
 * Close Agent panel — the Month-End tab's home for the close agent (P5.2/P5.3).
 *
 * Honesty rules made visible: nothing posts without an explicit Approve; every
 * proposal shows its evidence; the accuracy panel shows proposed-vs-accepted.
 * The agent NEVER posts on its own — this component only ever calls the decide
 * endpoint in response to a click.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import {
  Loader2, ShieldCheck, CheckCircle2, XCircle, EyeOff, ChevronDown, ChevronRight, Sparkles, Info,
} from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import {
  resolvePeriodId, groupProposals, formatAcceptance, type SlimPeriod,
} from '@/lib/closeAgentView';
import type {
  CloseRunWithProposals, CloseProposal, AccuracyStats, Decision,
} from '@/modules/accounting/services/gl/closeRun/closeRunTypes';

interface Envelope<T> { success: boolean; data: T; error?: { message?: string } }

const STATUS_BADGE: Record<string, string> = {
  proposed: 'border-zinc-600 text-zinc-300',
  posted: 'border-emerald-500/40 text-emerald-300 bg-emerald-500/10',
  rejected: 'border-zinc-600 text-zinc-400',
  dismissed: 'border-zinc-600 text-zinc-400',
  failed: 'border-red-500/40 text-red-300 bg-red-500/10',
};

function EvidenceBlock({ p }: { p: CloseProposal }) {
  const ev = p.evidence;
  return (
    <div className="mt-2 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-xs text-zinc-400">
      <div className="flex items-center gap-1.5 text-zinc-300 font-medium mb-1">
        <Info className="w-3 h-3" /> Evidence
      </div>
      <div>{ev.summary}</div>
      {ev.query && <div className="mt-1 font-mono text-[11px] text-zinc-500">source: {ev.query}</div>}
      {Array.isArray(ev.rows) && ev.rows.length > 0 && (
        <div className="mt-2 overflow-x-auto">
          <table className="text-[11px] border-collapse">
            <tbody>
              {ev.rows.map((row, i) => (
                <tr key={i} className="border-t border-zinc-800">
                  {Object.entries(row).map(([k, v]) => (
                    <td key={k} className="px-2 py-1 text-zinc-400"><span className="text-zinc-600">{k}:</span> {String(v)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {ev.fixHref && (
        <Link href={ev.fixHref} className="mt-2 inline-block text-teal-400 hover:text-teal-300">Open the underlying data →</Link>
      )}
    </div>
  );
}

function ProposalRow({ p, busy, onDecide }: {
  p: CloseProposal; busy: boolean; onDecide: (id: string, d: Decision) => void;
}) {
  const [open, setOpen] = useState(false);
  const decided = p.status !== 'proposed';
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-zinc-100">{p.title}</span>
            <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border ${STATUS_BADGE[p.status] ?? 'border-zinc-700 text-zinc-400'}`}>{p.status}</span>
          </div>
          <p className="text-xs text-zinc-400 mt-1">{p.reasoning}</p>
          <button onClick={() => setOpen(o => !o)} aria-expanded={open} className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-300">
            {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />} Evidence
          </button>
          {open && <EvidenceBlock p={p} />}
        </div>
        {!decided && (
          <div className="flex flex-col gap-1.5 shrink-0">
            {p.actionType === 'auto_post' ? (
              <>
                <button disabled={busy} onClick={() => onDecide(p.id, 'approve')}
                  className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Approve &amp; post
                </button>
                <button disabled={busy} onClick={() => onDecide(p.id, 'reject')}
                  className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-md border border-zinc-700 text-zinc-300 hover:bg-zinc-800 disabled:opacity-50">
                  <XCircle className="w-3.5 h-3.5" /> Reject
                </button>
              </>
            ) : (
              <button disabled={busy} onClick={() => onDecide(p.id, 'dismiss')}
                className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-md border border-zinc-700 text-zinc-300 hover:bg-zinc-800 disabled:opacity-50">
                <EyeOff className="w-3.5 h-3.5" /> Dismiss
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function CloseAgentPanel({ period }: { period: string }) {
  const [periodInfo, setPeriodInfo] = useState<{ id: string; status: string } | null>(null);
  const [run, setRun] = useState<CloseRunWithProposals | null>(null);
  const [accuracy, setAccuracy] = useState<AccuracyStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Sequence token: a slower earlier load for a previous period must never
  // overwrite a faster later one after a rapid period switch (deep-link + picker).
  const reqRef = useRef(0);

  const load = useCallback(async (p: string) => {
    const reqId = ++reqRef.current;
    const stale = () => reqRef.current !== reqId;
    setLoading(true); setError(null); setRun(null); setPeriodInfo(null);
    try {
      const year = p.slice(0, 4);
      const perRes = await apiFetch(`/api/accounting/fiscal-periods?year=${year}`);
      const perJson = await perRes.json() as Envelope<SlimPeriod[]>;
      if (stale()) return;
      if (!perRes.ok || !perJson.success) throw new Error(perJson.error?.message ?? 'Could not load fiscal periods');
      const resolved = resolvePeriodId(perJson.data ?? [], p);
      setPeriodInfo(resolved);
      if (resolved) {
        const [runRes, accRes] = await Promise.all([
          apiFetch(`/api/accounting/close-run?periodId=${resolved.id}`),
          apiFetch('/api/accounting/close-run/accuracy'),
        ]);
        if (stale()) return;
        if (runRes.ok) {
          const rj = await runRes.json() as Envelope<CloseRunWithProposals>;
          if (!stale() && rj.success) setRun(rj.data);
        } // 404 = no run yet — leave null
        if (accRes.ok) {
          const aj = await accRes.json() as Envelope<AccuracyStats>;
          if (!stale() && aj.success) setAccuracy(aj.data);
        }
      }
    } catch (e) {
      if (!stale()) setError(e instanceof Error ? e.message : 'Failed to load the close agent');
    } finally {
      if (!stale()) setLoading(false);
    }
  }, []);

  useEffect(() => { void load(period); }, [period, load]);

  // reqId is captured at the START of the mutation (in doPost) so a period switch
  // whose load() completes even BEFORE this refresh begins is still detected —
  // load() bumps reqRef, so the captured id no longer matches and we bail.
  const refresh = useCallback(async (periodId: string, reqId: number) => {
    const stale = () => reqRef.current !== reqId;
    const [runRes, accRes] = await Promise.all([
      apiFetch(`/api/accounting/close-run?periodId=${periodId}`),
      apiFetch('/api/accounting/close-run/accuracy'),
    ]);
    if (stale()) return;
    if (runRes.ok) { const rj = await runRes.json() as Envelope<CloseRunWithProposals>; if (!stale() && rj.success) setRun(rj.data); }
    if (accRes.ok) { const aj = await accRes.json() as Envelope<AccuracyStats>; if (!stale() && aj.success) setAccuracy(aj.data); }
  }, []);

  const doPost = useCallback(async (url: string, body: object, onOk: (reqId: number) => Promise<void>) => {
    const reqId = reqRef.current; // the load generation this action belongs to
    setBusy(true); setError(null);
    try {
      const res = await apiFetch(url, { method: 'POST', body: JSON.stringify(body) });
      const json = await res.json() as Envelope<unknown>;
      if (!res.ok || !json.success) throw new Error(json.error?.message ?? 'Action failed');
      await onOk(reqId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed');
    } finally { setBusy(false); }
  }, []);

  const start = useCallback(() => {
    if (!periodInfo) return;
    void doPost('/api/accounting/close-run', { periodId: periodInfo.id }, reqId => refresh(periodInfo.id, reqId));
  }, [periodInfo, doPost, refresh]);

  const decide = useCallback((proposalId: string, decision: Decision) => {
    if (!run || !periodInfo) return;
    void doPost('/api/accounting/close-run/decide', { runId: run.run.id, proposalId, decision }, reqId => refresh(periodInfo.id, reqId));
  }, [run, periodInfo, doPost, refresh]);

  const complete = useCallback(() => {
    if (!run || !periodInfo) return;
    void doPost('/api/accounting/close-run/complete', { runId: run.run.id }, reqId => refresh(periodInfo.id, reqId));
  }, [run, periodInfo, doPost, refresh]);

  const grouped = run ? groupProposals(run.proposals) : null;

  return (
    <div className="rounded-xl border border-teal-900/40 bg-gradient-to-b from-teal-950/20 to-zinc-900/40 p-4">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-teal-400" />
          <h2 className="text-sm font-semibold text-zinc-100">Close Agent</h2>
        </div>
        {run && (
          <span className="text-[11px] text-zinc-400">Run status: <span className="text-zinc-200">{run.run.status}</span></span>
        )}
      </div>
      <p className="text-xs text-zinc-400 mb-3 flex items-center gap-1.5">
        <ShieldCheck className="w-3.5 h-3.5 text-teal-500" />
        Nothing is posted until you approve it. Every suggestion shows its evidence.
      </p>

      {accuracy && (
        <div className="mb-3 text-xs text-zinc-400 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2">
          {formatAcceptance(accuracy)}
        </div>
      )}

      {loading && (
        <div className="flex items-center gap-2 text-sm text-zinc-400 py-6"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
      )}
      {error && !loading && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300 mb-3">{error}</div>
      )}

      {!loading && !periodInfo && (
        <div className="text-xs text-zinc-500 py-4">No fiscal period exists for this month — create one first.</div>
      )}

      {!loading && periodInfo && !run && (
        <button disabled={busy} onClick={start}
          className="inline-flex items-center gap-2 text-sm px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-500 text-white disabled:opacity-50">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />} Start close run
        </button>
      )}

      {!loading && run && grouped && (
        <div className="space-y-4">
          {grouped.autoPost.length > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-wide text-zinc-500 mb-1.5">Proposed postings ({grouped.autoPost.length})</div>
              <div className="space-y-2">{grouped.autoPost.map(p => <ProposalRow key={p.id} p={p} busy={busy} onDecide={decide} />)}</div>
            </div>
          )}
          {grouped.advisory.length > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-wide text-zinc-500 mb-1.5">Needs your attention ({grouped.advisory.length})</div>
              <div className="space-y-2">{grouped.advisory.map(p => <ProposalRow key={p.id} p={p} busy={busy} onDecide={decide} />)}</div>
            </div>
          )}
          {grouped.autoPost.length === 0 && grouped.advisory.length === 0 && (
            <div className="text-xs text-emerald-300 py-2">Nothing to propose — this period is clean.</div>
          )}
          <div className="flex items-center justify-between pt-2 border-t border-zinc-800">
            <span className="text-[11px] text-zinc-500">
              {grouped.pendingCount > 0 ? `${grouped.pendingCount} item(s) still to decide` : 'All items decided'}
            </span>
            {run.run.status !== 'completed' && (
              <button disabled={busy || grouped.pendingCount > 0} onClick={complete}
                className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-zinc-100 text-zinc-900 hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed">
                <CheckCircle2 className="w-3.5 h-3.5" /> Complete close
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
