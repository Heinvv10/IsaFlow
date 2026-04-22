/**
 * Audit Trail Exports — PRD-05 Phase 12.
 * List existing packs, build a new one for a period, invite auditors.
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import {
  FileCheck, Plus, RefreshCw, Loader2, AlertCircle, Download, Link as LinkIcon,
  ShieldCheck, Copy, Check, X,
} from 'lucide-react';

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
  error: string | null;
  requestedAt: string;
  builtAt: string | null;
}

interface PortalSession {
  id: string;
  auditorEmail: string;
  issuedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  useCount: number;
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

function fmtDate(s: string | null): string {
  if (!s) return '—';
  try { return new Date(s).toLocaleString('en-ZA'); } catch { return s; }
}

export default function AuditTrailPage() {
  const [exports, setExports] = useState<AuditExport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  const [createMode, setCreateMode] = useState(false);
  const [periodStart, setPeriodStart] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1).toISOString().slice(0, 10));
  const [periodEnd, setPeriodEnd] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 0).toISOString().slice(0, 10));
  const [creating, setCreating] = useState(false);

  const [inviteId, setInviteId] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteTtl, setInviteTtl] = useState('168');
  const [inviteResult, setInviteResult] = useState<{ portalUrl: string; accessToken: string } | null>(null);
  const [sessions, setSessions] = useState<PortalSession[]>([]);
  const [copiedUrl, setCopiedUrl] = useState(false);

  const showToast = useCallback((msg: string, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  }, []);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await apiFetch('/api/accounting/audit-exports');
      const json = await res.json() as { data?: { exports?: AuditExport[] }; error?: { message?: string } | string };
      if (!res.ok) {
        setError(typeof json.error === 'string' ? json.error : json.error?.message ?? 'Failed'); return;
      }
      setExports(json.data?.exports ?? []);
    } catch { setError('Network error'); }
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
      const json = await res.json() as { data?: { export?: AuditExport }; error?: { message?: string } | string };
      if (!res.ok) {
        showToast(typeof json.error === 'string' ? json.error : json.error?.message ?? 'Build failed', false);
        return;
      }
      showToast(`Pack ready — ${json.data?.export?.jeCount ?? 0} JEs`, true);
      setCreateMode(false);
      void load();
    } catch { showToast('Network error', false); }
    finally { setCreating(false); }
  }

  async function openInvite(id: string) {
    setInviteId(id);
    setInviteEmail(''); setInviteTtl('168');
    setInviteResult(null);
    try {
      const res = await apiFetch(`/api/accounting/audit-exports/${id}/sessions`);
      const json = await res.json() as { data?: { sessions?: PortalSession[] } };
      setSessions(json.data?.sessions ?? []);
    } catch { setSessions([]); }
  }

  async function handleInvite() {
    if (!inviteId || !inviteEmail) return;
    try {
      const res = await apiFetch(`/api/accounting/audit-exports/${inviteId}/sessions`, {
        method: 'POST',
        body: JSON.stringify({ auditorEmail: inviteEmail, ttlHours: parseInt(inviteTtl, 10) }),
      });
      const json = await res.json() as { data?: { portalUrl?: string; accessToken?: string }; error?: { message?: string } | string };
      if (!res.ok || !json.data?.portalUrl) {
        showToast(typeof json.error === 'string' ? json.error : json.error?.message ?? 'Invite failed', false); return;
      }
      setInviteResult({ portalUrl: json.data.portalUrl, accessToken: json.data.accessToken ?? '' });
      setInviteEmail('');
      const sres = await apiFetch(`/api/accounting/audit-exports/${inviteId}/sessions`);
      const sjson = await sres.json() as { data?: { sessions?: PortalSession[] } };
      setSessions(sjson.data?.sessions ?? []);
    } catch { showToast('Network error', false); }
  }

  async function revokeSession(id: string) {
    if (!inviteId) return;
    if (!confirm('Revoke this auditor session?')) return;
    try {
      const res = await apiFetch(`/api/accounting/audit-exports/${inviteId}/sessions/${id}`, { method: 'DELETE' });
      if (res.ok) {
        showToast('Revoked', true);
        const sres = await apiFetch(`/api/accounting/audit-exports/${inviteId}/sessions`);
        const sjson = await sres.json() as { data?: { sessions?: PortalSession[] } };
        setSessions(sjson.data?.sessions ?? []);
      }
    } catch { showToast('Network error', false); }
  }

  async function copyUrl(url: string) {
    await navigator.clipboard.writeText(url);
    setCopiedUrl(true);
    setTimeout(() => setCopiedUrl(false), 2000);
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
                      <td className="px-6 py-3 text-xs font-mono text-slate-500 max-w-[140px] truncate" title={e.pdfSha256 ?? ''}>
                        {e.pdfSha256 ? e.pdfSha256.slice(0, 16) + '…' : '—'}
                      </td>
                      <td className="px-6 py-3">
                        <div className="flex items-center gap-1 justify-end">
                          {e.status === 'ready' && (
                            <>
                              <a href={`/api/accounting/audit-exports/${e.id}/download`}
                                 className="p-1.5 text-teal-400 hover:text-teal-300 rounded hover:bg-white/10" title="Download PDF">
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
                  <label className="text-xs text-slate-400 mb-1 block">Period start</label>
                  <input type="date" value={periodStart} onChange={e => setPeriodStart(e.target.value)}
                    className="w-full px-3 py-2 rounded bg-white/5 border border-[rgba(255,255,255,0.1)] text-slate-200" />
                </div>
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">Period end</label>
                  <input type="date" value={periodEnd} onChange={e => setPeriodEnd(e.target.value)}
                    className="w-full px-3 py-2 rounded bg-white/5 border border-[rgba(255,255,255,0.1)] text-slate-200" />
                </div>
                <p className="text-xs text-slate-500">Includes all posted journal entries in the range, sealed with a SHA-256 hash.</p>
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
        {inviteId && (
          <div className="fixed inset-0 bg-black/60 z-40 flex justify-end" onClick={() => { setInviteId(null); setInviteResult(null); }}>
            <div className="w-full max-w-xl h-full bg-[var(--ff-canvas-mid)] border-l border-[rgba(255,255,255,0.08)] overflow-y-auto" onClick={e => e.stopPropagation()}>
              <div className="px-5 py-4 border-b border-[rgba(255,255,255,0.08)] flex items-center justify-between">
                <h3 className="text-base font-semibold text-[var(--ff-text-primary)]">Invite auditor</h3>
                <button onClick={() => { setInviteId(null); setInviteResult(null); }} className="text-slate-400 hover:text-slate-200">✕</button>
              </div>
              <div className="px-5 py-4 space-y-4 text-sm">
                <div className="bg-white/5 border border-[rgba(255,255,255,0.08)] rounded-lg p-3 space-y-2">
                  <div>
                    <label className="text-xs text-slate-400 mb-1 block">Auditor email</label>
                    <input value={inviteEmail} onChange={e => setInviteEmail(e.target.value)} placeholder="auditor@firm.co.za"
                      className="w-full px-3 py-2 rounded bg-white/5 border border-[rgba(255,255,255,0.1)] text-slate-200" />
                  </div>
                  <div>
                    <label className="text-xs text-slate-400 mb-1 block">TTL (hours)</label>
                    <input type="number" value={inviteTtl} onChange={e => setInviteTtl(e.target.value)}
                      className="w-full px-3 py-2 rounded bg-white/5 border border-[rgba(255,255,255,0.1)] text-slate-200" />
                  </div>
                  <button onClick={() => void handleInvite()}
                    className="w-full mt-1 px-4 py-2 rounded bg-teal-600 hover:bg-teal-500 text-white text-sm font-medium">
                    Create portal link
                  </button>
                </div>

                {inviteResult && (
                  <div className="bg-teal-900/20 border border-teal-700/40 rounded-lg p-3 space-y-2">
                    <p className="text-xs text-teal-300 font-semibold">Copy this now — it won't be shown again</p>
                    <div className="flex items-center gap-2">
                      <input readOnly value={inviteResult.portalUrl}
                        className="flex-1 px-2 py-1 rounded bg-black/40 border border-[rgba(255,255,255,0.1)] text-slate-200 font-mono text-xs" />
                      <button onClick={() => void copyUrl(inviteResult.portalUrl)}
                        className="px-2 py-1 rounded bg-white/10 hover:bg-white/20 text-slate-300 text-xs">
                        {copiedUrl ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                  </div>
                )}

                <div>
                  <p className="text-xs text-slate-500 uppercase tracking-wider mb-2">Existing sessions</p>
                  {sessions.length === 0 ? (
                    <p className="text-xs text-slate-600">None yet</p>
                  ) : (
                    <ul className="space-y-2">
                      {sessions.map(s => (
                        <li key={s.id} className="flex items-start justify-between px-3 py-2 rounded bg-white/5">
                          <div className="min-w-0">
                            <p className="text-sm text-slate-200 truncate">{s.auditorEmail}</p>
                            <p className="text-xs text-slate-500">
                              {s.revokedAt ? 'Revoked' : `Expires ${fmtDate(s.expiresAt)}`} · used {s.useCount}×
                            </p>
                          </div>
                          {!s.revokedAt && (
                            <button onClick={() => void revokeSession(s.id)}
                              className="p-1 text-red-400 hover:text-red-300" title="Revoke">
                              <X className="h-4 w-4" />
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </AppLayout>
  );
}
