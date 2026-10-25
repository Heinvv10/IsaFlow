/**
 * Audit Trail Exports — PRD-05 Phase 12.
 * List existing packs, build a new one for a period, invite auditors.
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { useTimeoutOnce } from '@/hooks/useTimeoutOnce';
import {
  FileCheck, Plus, RefreshCw, Loader2, AlertCircle, Download, Link as LinkIcon,
  ShieldCheck,
} from 'lucide-react';
import { localISODate } from '@/lib/dateUtils';
import { AuditSnapshotsPanel } from '@/components/accounting/audit/AuditSnapshotsPanel';
import { AuditInviteDrawer } from '@/components/accounting/audit/AuditInviteDrawer';

interface AuditExport {
  id: string;
  periodStart: string;
  periodEnd: string;
  status: 'queued' | 'building' | 'ready' | 'failed';
  jeCount: number;
  lineCount: number;
  documentCount: number;
  totalDebits: number;
  totalCredits: number;
  pdfSha256: string | null;
  zipSha256?: string | null;
  error: string | null;
  requestedAt: string;
  builtAt: string | null;
}


const STATUS_STYLES: Record<AuditExport['status'], string> = {
  queued:   'bg-slate-700 text-slate-300',
  building: 'bg-amber-900/50 text-amber-300',
  ready:    'bg-teal-900/50 text-teal-300',
  failed:   'bg-red-900/50 text-red-300',
};

function fmtZAR(n: number): string {
  return `R ${n.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function AuditTrailPage() {
  const [exports, setExports] = useState<AuditExport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  const [createMode, setCreateMode] = useState(false);
  const [periodStart, setPeriodStart] = useState(() => localISODate(new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1)));
  const [periodEnd, setPeriodEnd] = useState(() => localISODate(new Date(new Date().getFullYear(), new Date().getMonth(), 0)));
  const [creating, setCreating] = useState(false);

  const [inviteId, setInviteId] = useState<string | null>(null);

  const afterToast = useTimeoutOnce();
  const showToast = useCallback((msg: string, ok = true) => {
    setToast({ msg, ok });
    afterToast(() => setToast(null), 3500);
  }, [afterToast]);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await apiFetch('/api/accounting/audit-exports');
      await assertOk(res, 'Could not load the audit packs - try again');
      const json = await res.json() as { data?: { exports?: AuditExport[] } };
      setExports(json.data?.exports ?? []);
    } catch (err) { setExports([]); setError(apiErrorMessage(err, 'Could not load the audit packs - try again')); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function handleCreate() {
    if (!periodStart || !periodEnd) { showToast('Period required', false); return; }
    setCreating(true);
    try {
      const res = await apiFetch('/api/accounting/audit-exports', {
        method: 'POST',
        body: JSON.stringify({ periodStart, periodEnd }),
      });
      await assertOk(res, 'Could not build the audit pack - try again');
      const json = await res.json() as { data?: { export?: AuditExport } };
      showToast(`Pack ready — ${json.data?.export?.jeCount ?? 0} JEs`, true);
      setCreateMode(false);
      void load();
    } catch (err) { showToast(apiErrorMessage(err, 'Could not build the audit pack - try again'), false); }
    finally { setCreating(false); }
  }

  function openInvite(id: string) {
    setInviteId(id);
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="px-6 py-4 border-b border-[var(--ff-border-light)] flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-[var(--ff-text-primary)] flex items-center gap-2">
              <FileCheck className="h-5 w-5 text-teal-400" /> Audit Trail
            </h1>
            <p className="text-sm text-[var(--ff-text-secondary)] mt-0.5">
              Generate signed evidence packs for a period and share them with auditors via time-limited portal links.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => void load()} className="inline-flex items-center gap-2 px-3 py-2 rounded bg-white/5 hover:bg-white/10 text-slate-300 text-sm">
              <RefreshCw className="h-4 w-4" />
            </button>
            <button onClick={() => setCreateMode(true)}
              className="inline-flex items-center gap-2 px-3 py-2 rounded bg-teal-600 hover:bg-teal-500 text-white text-sm font-medium">
              <Plus className="h-4 w-4" /> New pack
            </button>
          </div>
        </div>

        {toast && (
          <div className={`fixed top-4 right-4 z-50 px-4 py-2 rounded shadow-lg text-sm ${toast.ok ? 'bg-teal-600 text-white' : 'bg-red-700 text-white'}`}>
            {toast.msg}
          </div>
        )}

        <div className="px-6 py-6">
          <AuditSnapshotsPanel onPackBuilt={() => void load()} notify={showToast} />
          <div className="bg-[var(--ff-canvas-mid)] border border-[rgba(255,255,255,0.08)] rounded-xl overflow-hidden">
            {loading ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="h-6 w-6 animate-spin text-teal-500" />
              </div>
            ) : error ? (
              <div className="flex items-center gap-2 text-red-400 py-10 justify-center">
                <AlertCircle className="h-5 w-5" />{error}
              </div>
            ) : exports.length === 0 ? (
              <div className="py-16 text-center">
                <ShieldCheck className="h-10 w-10 mx-auto text-slate-600 mb-3" />
                <p className="text-slate-400 text-sm">No audit packs yet</p>
                <p className="text-slate-600 text-xs mt-1">Generate your first pack for a closed period.</p>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500 uppercase tracking-wider border-b border-[rgba(255,255,255,0.06)]">
                    <th className="px-6 py-3 font-medium">Period</th>
                    <th className="px-6 py-3 font-medium">Status</th>
                    <th className="px-6 py-3 text-right font-medium">JEs</th>
                    <th className="px-6 py-3 text-right font-medium">Docs</th>
                    <th className="px-6 py-3 text-right font-medium">DR</th>
                    <th className="px-6 py-3 text-right font-medium">CR</th>
                    <th className="px-6 py-3 font-medium">SHA-256</th>
                    <th className="px-6 py-3 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[rgba(255,255,255,0.04)]">
                  {exports.map(e => (
                    <tr key={e.id} className="hover:bg-white/5">
                      <td className="px-6 py-3 text-slate-300">{e.periodStart} → {e.periodEnd}</td>
                      <td className="px-6 py-3">
                        <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${STATUS_STYLES[e.status]}`}>
                          {e.status}
                        </span>
                        {e.error && <p className="text-xs text-red-400 mt-1 max-w-[200px] truncate" title={e.error}>{e.error}</p>}
                      </td>
                      <td className="px-6 py-3 text-right text-slate-300">{e.jeCount}</td>
                      <td className="px-6 py-3 text-right text-slate-300">{e.documentCount}</td>
                      <td className="px-6 py-3 text-right text-slate-300">{fmtZAR(e.totalDebits)}</td>
                      <td className="px-6 py-3 text-right text-slate-300">{fmtZAR(e.totalCredits)}</td>
                      <td className="px-6 py-3 text-xs font-mono text-slate-500 max-w-[140px] truncate" title={e.zipSha256 ?? e.pdfSha256 ?? ''}>
                        {(e.zipSha256 ?? e.pdfSha256) ? (e.zipSha256 ?? e.pdfSha256)!.slice(0, 16) + '…' : '—'}
                      </td>
                      <td className="px-6 py-3">
                        <div className="flex items-center gap-1 justify-end">
                          {e.status === 'ready' && (
                            <>
                              <a href={`/api/accounting/audit-exports/${e.id}/download`}
                                 className="p-1.5 text-teal-400 hover:text-teal-300 rounded hover:bg-white/10" title="Download pack">
                                <Download className="h-4 w-4" />
                              </a>
                              <button onClick={() => void openInvite(e.id)}
                                className="p-1.5 text-slate-300 hover:text-slate-100 rounded hover:bg-white/10" title="Invite auditor">
                                <LinkIcon className="h-4 w-4" />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Create modal */}
        {createMode && (
          <div className="fixed inset-0 bg-black/60 z-40 flex items-center justify-center p-4" onClick={() => !creating && setCreateMode(false)}>
            <div className="w-full max-w-md bg-[var(--ff-canvas-mid)] border border-[rgba(255,255,255,0.08)] rounded-xl p-6" onClick={e => e.stopPropagation()}>
              <h3 className="text-base font-semibold text-[var(--ff-text-primary)] mb-4">New audit pack</h3>
              <div className="space-y-3 text-sm">
                <div>
                  <label htmlFor="audit-pack-period-start" className="text-xs text-slate-400 mb-1 block">Period start</label>
                  <input id="audit-pack-period-start" type="date" value={periodStart} onChange={e => setPeriodStart(e.target.value)}
                    className="w-full px-3 py-2 rounded bg-white/5 border border-[rgba(255,255,255,0.1)] text-slate-200" />
                </div>
                <div>
                  <label htmlFor="audit-pack-period-end" className="text-xs text-slate-400 mb-1 block">Period end</label>
                  <input id="audit-pack-period-end" type="date" value={periodEnd} onChange={e => setPeriodEnd(e.target.value)}
                    className="w-full px-3 py-2 rounded bg-white/5 border border-[rgba(255,255,255,0.1)] text-slate-200" />
                </div>
                <p className="text-xs text-slate-500">Takes a sealed audit snapshot at the period end and builds the pack from it: a ZIP whose manifest cites the snapshot&rsquo;s hash, with the PDF inside.</p>
              </div>
              <div className="mt-5 flex gap-2 justify-end">
                <button onClick={() => setCreateMode(false)} disabled={creating} className="px-4 py-2 text-sm text-slate-300 hover:bg-white/5 rounded">Cancel</button>
                <button onClick={() => void handleCreate()} disabled={creating}
                  className="px-4 py-2 rounded bg-teal-600 hover:bg-teal-500 text-white text-sm font-medium disabled:opacity-60">
                  {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Build pack'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Invite drawer */}
        {inviteId && <AuditInviteDrawer key={inviteId} exportId={inviteId} onClose={() => setInviteId(null)} notify={showToast} />}
      </div>
    </AppLayout>
  );
}
