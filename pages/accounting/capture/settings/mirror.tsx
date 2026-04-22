/**
 * Mirror Inbox Settings — PRD-05 Phase 9
 *
 * Connect external mailboxes so invoices appear in the capture inbox
 * without manual forwarding. MVP ships generic IMAP (host/port/user/pass);
 * Gmail + M365 OAuth buttons are stubbed pending Google/Microsoft app
 * registration.
 */

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import {
  Mail, Server, Plus, RefreshCw, AlertCircle, Loader2, Trash2,
  PowerOff, ChevronLeft, ListChecks, CheckCircle2, XCircle,
} from 'lucide-react';

interface Connection {
  id: string;
  provider: 'gmail' | 'm365' | 'imap';
  displayName: string;
  accountEmail: string;
  status: 'active' | 'disconnected' | 'error';
  folder: string;
  scanIntervalMinutes: number;
  allowedSenders: string[];
  deniedSenders: string[];
  messagesIngestedTotal: number;
  lastScanAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
}

interface ScanLogEntry {
  id: string;
  imap_uid: string | null;
  sender: string | null;
  subject: string | null;
  attachment_count: number;
  outcome: string;
  error: string | null;
  scanned_at: string;
}

type ToastState = { msg: string; ok: boolean } | null;

function fmtDate(val: string | null | undefined): string {
  if (!val) return 'never';
  try { return new Date(val).toLocaleString('en-ZA'); } catch { return String(val); }
}

function StatusPill({ status }: { status: Connection['status'] }) {
  const map: Record<Connection['status'], string> = {
    active: 'bg-teal-900/50 text-teal-300',
    disconnected: 'bg-slate-800 text-slate-400',
    error: 'bg-red-900/50 text-red-300',
  };
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium ${map[status]}`}>
      {status === 'active' && <CheckCircle2 className="h-3 w-3" />}
      {status === 'error' && <XCircle className="h-3 w-3" />}
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

export default function MirrorSettingsPage() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [addMode, setAddMode] = useState(false);
  const [scanningId, setScanningId] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState>(null);
  const [logOpenId, setLogOpenId] = useState<string | null>(null);
  const [logEntries, setLogEntries] = useState<ScanLogEntry[]>([]);

  // New-connection form
  const [displayName, setDisplayName] = useState('');
  const [accountEmail, setAccountEmail] = useState('');
  const [imapHost, setImapHost] = useState('');
  const [imapPort, setImapPort] = useState('993');
  const [imapUseTls, setImapUseTls] = useState(true);
  const [imapUsername, setImapUsername] = useState('');
  const [imapPassword, setImapPassword] = useState('');
  const [allowedSenders, setAllowedSenders] = useState('');
  const [saving, setSaving] = useState(false);

  const showToast = useCallback((msg: string, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  }, []);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await apiFetch('/api/accounting/capture/mirror');
      const json = await res.json() as { data?: { items?: Connection[] }; error?: { message?: string } | string };
      if (!res.ok) {
        const msg = typeof json.error === 'string' ? json.error : json.error?.message ?? 'Failed to load connections';
        setError(msg); return;
      }
      setConnections(json.data?.items ?? []);
    } catch { setError('Network error loading mirror connections'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function handleCreate() {
    if (!displayName || !accountEmail || !imapHost || !imapPort || !imapUsername || !imapPassword) {
      showToast('All fields are required', false); return;
    }
    setSaving(true);
    try {
      const res = await apiFetch('/api/accounting/capture/mirror', {
        method: 'POST',
        body: JSON.stringify({
          displayName, accountEmail, imapHost,
          imapPort: parseInt(imapPort, 10),
          imapUseTls, imapUsername, imapPassword,
          allowedSenders: allowedSenders.split(',').map(s => s.trim()).filter(Boolean),
        }),
      });
      const json = await res.json() as { error?: { message?: string } | string };
      if (!res.ok) {
        const msg = typeof json.error === 'string' ? json.error : json.error?.message ?? 'Create failed';
        showToast(msg, false); return;
      }
      showToast('Mirror connection added', true);
      setAddMode(false);
      setDisplayName(''); setAccountEmail(''); setImapHost(''); setImapUsername('');
      setImapPassword(''); setAllowedSenders('');
      void load();
    } catch { showToast('Network error', false); }
    finally { setSaving(false); }
  }

  async function handleScanNow(id: string) {
    setScanningId(id);
    try {
      const res = await apiFetch(`/api/accounting/capture/mirror/${id}/scan-now`, { method: 'POST', body: '{}' });
      const json = await res.json() as { data?: { ingested?: number; scanned?: number; errors?: number }; error?: { message?: string } | string };
      if (!res.ok) {
        const msg = typeof json.error === 'string' ? json.error : json.error?.message ?? 'Scan failed';
        showToast(msg, false); return;
      }
      const d = json.data ?? {};
      showToast(`Scanned ${d.scanned ?? 0}, ingested ${d.ingested ?? 0}${d.errors ? `, ${d.errors} errors` : ''}`, true);
      void load();
    } catch { showToast('Network error', false); }
    finally { setScanningId(null); }
  }

  async function handleDisconnect(id: string) {
    if (!confirm('Disconnect this mirror and wipe stored credentials?')) return;
    try {
      const res = await apiFetch(`/api/accounting/capture/mirror/${id}/disconnect`, { method: 'POST', body: '{}' });
      const json = await res.json() as { error?: { message?: string } | string };
      if (!res.ok) {
        const msg = typeof json.error === 'string' ? json.error : json.error?.message ?? 'Disconnect failed';
        showToast(msg, false); return;
      }
      showToast('Disconnected', true);
      void load();
    } catch { showToast('Network error', false); }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this mirror connection entirely? Scan history is also removed.')) return;
    try {
      const res = await apiFetch(`/api/accounting/capture/mirror/${id}`, { method: 'DELETE' });
      const json = await res.json() as { error?: { message?: string } | string };
      if (!res.ok) {
        const msg = typeof json.error === 'string' ? json.error : json.error?.message ?? 'Delete failed';
        showToast(msg, false); return;
      }
      showToast('Removed', true);
      void load();
    } catch { showToast('Network error', false); }
  }

  async function openLog(id: string) {
    setLogOpenId(id);
    setLogEntries([]);
    try {
      const res = await apiFetch(`/api/accounting/capture/mirror/${id}/log?limit=100`);
      const json = await res.json() as { data?: { entries?: ScanLogEntry[] } };
      setLogEntries(json.data?.entries ?? []);
    } catch { /* non-fatal */ }
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="px-6 py-4 border-b border-[var(--ff-border-light)] flex items-center justify-between">
          <div>
            <Link href="/accounting/capture/settings" className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300 mb-1">
              <ChevronLeft className="h-3 w-3" /> Capture settings
            </Link>
            <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">Mirror Inboxes</h1>
            <p className="text-sm text-[var(--ff-text-secondary)] mt-0.5">
              Connect external mailboxes read-only — invoices appear in the capture inbox automatically.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => void load()} className="inline-flex items-center gap-2 px-3 py-2 rounded bg-white/5 hover:bg-white/10 text-slate-300 text-sm">
              <RefreshCw className="h-4 w-4" /> Refresh
            </button>
            <button onClick={() => setAddMode(true)} className="inline-flex items-center gap-2 px-3 py-2 rounded bg-teal-600 hover:bg-teal-500 text-white text-sm font-medium">
              <Plus className="h-4 w-4" /> Add IMAP mailbox
            </button>
          </div>
        </div>

        {toast && (
          <div className={`fixed top-4 right-4 z-50 px-4 py-2 rounded shadow-lg text-sm ${toast.ok ? 'bg-teal-600 text-white' : 'bg-red-700 text-white'}`}>
            {toast.msg}
          </div>
        )}

        <div className="px-6 py-6 space-y-6">
          {/* OAuth providers — stubs */}
          <div className="bg-[var(--ff-canvas-mid)] border border-[rgba(255,255,255,0.08)] rounded-xl p-6">
            <h2 className="text-base font-semibold text-[var(--ff-text-primary)] mb-3">One-click providers</h2>
            <p className="text-sm text-slate-400 mb-4">
              OAuth flows for Gmail and Microsoft 365 are on the way — until then, connect them via IMAP using an app password.
            </p>
            <div className="grid md:grid-cols-2 gap-3">
              <div className="p-4 rounded-lg bg-white/5 border border-[rgba(255,255,255,0.06)] opacity-60">
                <div className="flex items-center gap-3 mb-2">
                  <Mail className="h-5 w-5 text-slate-400" />
                  <div>
                    <p className="text-sm font-medium text-slate-200">Gmail</p>
                    <p className="text-xs text-slate-500">OAuth — coming soon</p>
                  </div>
                </div>
                <button disabled className="w-full mt-2 py-2 rounded bg-white/5 text-slate-500 text-sm cursor-not-allowed">Connect</button>
              </div>
              <div className="p-4 rounded-lg bg-white/5 border border-[rgba(255,255,255,0.06)] opacity-60">
                <div className="flex items-center gap-3 mb-2">
                  <Mail className="h-5 w-5 text-slate-400" />
                  <div>
                    <p className="text-sm font-medium text-slate-200">Microsoft 365</p>
                    <p className="text-xs text-slate-500">OAuth — coming soon</p>
                  </div>
                </div>
                <button disabled className="w-full mt-2 py-2 rounded bg-white/5 text-slate-500 text-sm cursor-not-allowed">Connect</button>
              </div>
            </div>
          </div>

          {/* Connections list */}
          <div className="bg-[var(--ff-canvas-mid)] border border-[rgba(255,255,255,0.08)] rounded-xl overflow-hidden">
            <div className="px-6 py-4 border-b border-[rgba(255,255,255,0.06)]">
              <h2 className="text-base font-semibold text-[var(--ff-text-primary)]">Configured mailboxes</h2>
            </div>

            {loading ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="h-6 w-6 animate-spin text-teal-500" />
              </div>
            ) : error ? (
              <div className="flex items-center gap-2 text-red-400 py-10 justify-center">
                <AlertCircle className="h-5 w-5" /><span>{error}</span>
              </div>
            ) : connections.length === 0 ? (
              <div className="py-14 text-center">
                <Server className="h-8 w-8 mx-auto text-slate-600 mb-3" />
                <p className="text-slate-400 text-sm">No mirror inboxes connected yet.</p>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500 uppercase tracking-wider border-b border-[rgba(255,255,255,0.06)]">
                    <th className="px-6 py-3 font-medium">Mailbox</th>
                    <th className="px-6 py-3 font-medium">Status</th>
                    <th className="px-6 py-3 font-medium">Last scan</th>
                    <th className="px-6 py-3 text-right font-medium">Ingested</th>
                    <th className="px-6 py-3 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[rgba(255,255,255,0.04)]">
                  {connections.map(c => (
                    <tr key={c.id} className="hover:bg-white/5">
                      <td className="px-6 py-3">
                        <p className="text-slate-200 font-medium">{c.displayName}</p>
                        <p className="text-xs text-slate-500 font-mono">{c.accountEmail} · {c.folder}</p>
                      </td>
                      <td className="px-6 py-3">
                        <StatusPill status={c.status} />
                        {c.lastError && (
                          <p className="mt-1 text-xs text-red-400 max-w-[240px] truncate" title={c.lastError}>{c.lastError}</p>
                        )}
                      </td>
                      <td className="px-6 py-3 text-slate-400 text-xs">{fmtDate(c.lastSuccessAt ?? c.lastScanAt)}</td>
                      <td className="px-6 py-3 text-right text-slate-300 font-medium">{c.messagesIngestedTotal}</td>
                      <td className="px-6 py-3">
                        <div className="flex items-center gap-1 justify-end">
                          <button onClick={() => void handleScanNow(c.id)}
                            disabled={c.status !== 'active' || scanningId === c.id}
                            className="px-2 py-1 text-xs text-slate-300 hover:bg-white/10 rounded disabled:opacity-40">
                            {scanningId === c.id ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Scan now'}
                          </button>
                          <button onClick={() => void openLog(c.id)} className="p-1.5 text-slate-400 hover:text-slate-200 rounded hover:bg-white/10" title="Scan log">
                            <ListChecks className="h-4 w-4" />
                          </button>
                          {c.status === 'active' && (
                            <button onClick={() => void handleDisconnect(c.id)}
                              className="p-1.5 text-amber-400 hover:text-amber-300 rounded hover:bg-white/10" title="Disconnect">
                              <PowerOff className="h-4 w-4" />
                            </button>
                          )}
                          <button onClick={() => void handleDelete(c.id)}
                            className="p-1.5 text-red-400 hover:text-red-300 rounded hover:bg-white/10" title="Delete">
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Add-connection modal */}
        {addMode && (
          <div className="fixed inset-0 bg-black/60 z-40 flex items-center justify-center p-4" onClick={() => !saving && setAddMode(false)}>
            <div className="w-full max-w-lg bg-[var(--ff-canvas-mid)] border border-[rgba(255,255,255,0.08)] rounded-xl p-6" onClick={e => e.stopPropagation()}>
              <h3 className="text-base font-semibold text-[var(--ff-text-primary)] mb-4">Connect IMAP mailbox</h3>
              <div className="space-y-3 text-sm">
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">Display name</label>
                  <input value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="Finance Inbox"
                    className="w-full px-3 py-2 rounded bg-white/5 border border-[rgba(255,255,255,0.1)] text-slate-200 focus:outline-none focus:border-teal-500" />
                </div>
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">Account email</label>
                  <input value={accountEmail} onChange={e => setAccountEmail(e.target.value)} placeholder="billing@company.co.za"
                    className="w-full px-3 py-2 rounded bg-white/5 border border-[rgba(255,255,255,0.1)] text-slate-200 focus:outline-none focus:border-teal-500" />
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div className="col-span-2">
                    <label className="text-xs text-slate-400 mb-1 block">IMAP host</label>
                    <input value={imapHost} onChange={e => setImapHost(e.target.value)} placeholder="imap.gmail.com"
                      className="w-full px-3 py-2 rounded bg-white/5 border border-[rgba(255,255,255,0.1)] text-slate-200 font-mono text-xs focus:outline-none focus:border-teal-500" />
                  </div>
                  <div>
                    <label className="text-xs text-slate-400 mb-1 block">Port</label>
                    <input value={imapPort} onChange={e => setImapPort(e.target.value)} placeholder="993"
                      className="w-full px-3 py-2 rounded bg-white/5 border border-[rgba(255,255,255,0.1)] text-slate-200 font-mono text-xs focus:outline-none focus:border-teal-500" />
                  </div>
                </div>
                <label className="flex items-center gap-2 text-xs text-slate-400">
                  <input type="checkbox" checked={imapUseTls} onChange={e => setImapUseTls(e.target.checked)} className="rounded border-slate-600 bg-transparent" />
                  Use TLS (recommended)
                </label>
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">Username</label>
                  <input value={imapUsername} onChange={e => setImapUsername(e.target.value)} placeholder="billing@company.co.za"
                    className="w-full px-3 py-2 rounded bg-white/5 border border-[rgba(255,255,255,0.1)] text-slate-200 font-mono text-xs focus:outline-none focus:border-teal-500" />
                </div>
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">Password / App password</label>
                  <input type="password" value={imapPassword} onChange={e => setImapPassword(e.target.value)} placeholder="•••••••••••"
                    className="w-full px-3 py-2 rounded bg-white/5 border border-[rgba(255,255,255,0.1)] text-slate-200 font-mono text-xs focus:outline-none focus:border-teal-500" />
                  <p className="mt-1 text-xs text-slate-500">Stored encrypted at rest. For Gmail, generate an app password at myaccount.google.com.</p>
                </div>
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">Allowed senders (optional)</label>
                  <input value={allowedSenders} onChange={e => setAllowedSenders(e.target.value)} placeholder="billing@eskom.co.za, @telkom.co.za"
                    className="w-full px-3 py-2 rounded bg-white/5 border border-[rgba(255,255,255,0.1)] text-slate-200 text-xs focus:outline-none focus:border-teal-500" />
                  <p className="mt-1 text-xs text-slate-500">Comma-separated. Leave empty to scan all senders.</p>
                </div>
              </div>
              <div className="mt-5 flex gap-2 justify-end">
                <button onClick={() => setAddMode(false)} disabled={saving}
                  className="px-4 py-2 rounded text-sm text-slate-300 hover:bg-white/5">Cancel</button>
                <button onClick={() => void handleCreate()} disabled={saving}
                  className="px-4 py-2 rounded bg-teal-600 hover:bg-teal-500 text-white text-sm font-medium disabled:opacity-60">
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Connect'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Scan log drawer */}
        {logOpenId && (
          <div className="fixed inset-0 bg-black/60 z-40 flex justify-end" onClick={() => setLogOpenId(null)}>
            <div className="w-full max-w-xl h-full bg-[var(--ff-canvas-mid)] border-l border-[rgba(255,255,255,0.08)] overflow-y-auto" onClick={e => e.stopPropagation()}>
              <div className="px-5 py-4 border-b border-[rgba(255,255,255,0.08)] flex items-center justify-between">
                <h3 className="text-base font-semibold text-[var(--ff-text-primary)]">Scan log</h3>
                <button onClick={() => setLogOpenId(null)} className="text-slate-400 hover:text-slate-200">✕</button>
              </div>
              <div className="px-5 py-4 space-y-3">
                {logEntries.length === 0 ? (
                  <p className="text-sm text-slate-500 text-center py-8">No entries yet</p>
                ) : logEntries.map(e => (
                  <div key={e.id} className="px-3 py-2 rounded bg-white/5 border border-[rgba(255,255,255,0.04)]">
                    <div className="flex items-center justify-between mb-1">
                      <span className={`text-xs font-medium ${e.outcome === 'ingested' ? 'text-teal-400' : e.outcome === 'error' ? 'text-red-400' : 'text-slate-500'}`}>
                        {e.outcome.replace(/_/g, ' ')}
                      </span>
                      <span className="text-xs text-slate-500">{fmtDate(e.scanned_at)}</span>
                    </div>
                    <p className="text-xs text-slate-300 truncate">{e.subject ?? '—'}</p>
                    <p className="text-xs text-slate-500 font-mono truncate">{e.sender ?? '—'} · {e.attachment_count} att</p>
                    {e.error && <p className="text-xs text-red-400 mt-1 font-mono break-words">{e.error}</p>}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </AppLayout>
  );
}
