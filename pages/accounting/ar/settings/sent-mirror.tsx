/**
 * Sent-Folder Mirror Settings — PRD-06 Phase 6
 *
 * Connect an outbound mailbox so invoice PDFs you email from Gmail/Outlook
 * get linked back to their existing snapshots (via sha256) instead of
 * creating a duplicate captured_documents row. Ships generic IMAP.
 */

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import {
  Server, Plus, RefreshCw, AlertCircle, Loader2, Trash2,
  ChevronLeft, ListChecks, CheckCircle2, XCircle, Link2,
} from 'lucide-react';

interface Connection {
  id: string;
  provider: 'gmail' | 'm365' | 'imap';
  displayName: string;
  accountEmail: string;
  status: 'active' | 'disconnected' | 'error';
  sentFolder: string;
  scanIntervalMinutes: number;
  messagesCapturedTotal: number;
  messagesLinkedTotal: number;
  lastScanAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
}

interface ScanLogEntry {
  id: string;
  imap_uid: string | null;
  recipient: string | null;
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

function outcomeTone(outcome: string): string {
  if (outcome === 'linked_to_invoice') return 'text-teal-400';
  if (outcome === 'captured_outbound') return 'text-sky-400';
  if (outcome === 'error') return 'text-red-400';
  return 'text-slate-500';
}

export default function SentMirrorSettingsPage() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [addMode, setAddMode] = useState(false);
  const [scanningId, setScanningId] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState>(null);
  const [logOpenId, setLogOpenId] = useState<string | null>(null);
  const [logEntries, setLogEntries] = useState<ScanLogEntry[]>([]);

  const [displayName, setDisplayName] = useState('');
  const [accountEmail, setAccountEmail] = useState('');
  const [imapHost, setImapHost] = useState('');
  const [imapPort, setImapPort] = useState('993');
  const [imapUseTls, setImapUseTls] = useState(true);
  const [imapUsername, setImapUsername] = useState('');
  const [imapPassword, setImapPassword] = useState('');
  const [sentFolder, setSentFolder] = useState('Sent');
  const [saving, setSaving] = useState(false);

  const showToast = useCallback((msg: string, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  }, []);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await apiFetch('/api/accounting/ar/sent-mirror/connections');
      const json = await res.json() as { data?: { items?: Connection[] }; error?: { message?: string } | string };
      if (!res.ok) {
        const msg = typeof json.error === 'string' ? json.error : json.error?.message ?? 'Failed to load connections';
        setError(msg); return;
      }
      setConnections(json.data?.items ?? []);
    } catch { setError('Network error loading sent-mirror connections'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function handleCreate() {
    if (!displayName || !accountEmail || !imapHost || !imapPort || !imapUsername || !imapPassword) {
      showToast('All fields are required', false); return;
    }
    setSaving(true);
    try {
      const res = await apiFetch('/api/accounting/ar/sent-mirror/connections', {
        method: 'POST',
        body: JSON.stringify({
          displayName, accountEmail, imapHost,
          imapPort: parseInt(imapPort, 10),
          imapUseTls, imapUsername, imapPassword,
          sentFolder: sentFolder || 'Sent',
        }),
      });
      const json = await res.json() as { error?: { message?: string } | string };
      if (!res.ok) {
        const msg = typeof json.error === 'string' ? json.error : json.error?.message ?? 'Create failed';
        showToast(msg, false); return;
      }
      showToast('Sent-mirror connection added', true);
      setAddMode(false);
      setDisplayName(''); setAccountEmail(''); setImapHost(''); setImapUsername('');
      setImapPassword(''); setSentFolder('Sent');
      void load();
    } catch { showToast('Network error', false); }
    finally { setSaving(false); }
  }

  async function handleScanNow(id: string) {
    setScanningId(id);
    try {
      const res = await apiFetch(`/api/accounting/ar/sent-mirror/connections/${id}/scan-now`, { method: 'POST', body: '{}' });
      const json = await res.json() as {
        data?: { scanned?: number; linked?: number; captured?: number; errors?: number };
        error?: { message?: string } | string;
      };
      if (!res.ok) {
        const msg = typeof json.error === 'string' ? json.error : json.error?.message ?? 'Scan failed';
        showToast(msg, false); return;
      }
      const d = json.data ?? {};
      showToast(
        `Scanned ${d.scanned ?? 0} · linked ${d.linked ?? 0} · captured ${d.captured ?? 0}${d.errors ? ` · ${d.errors} errors` : ''}`,
        true,
      );
      void load();
    } catch { showToast('Network error', false); }
    finally { setScanningId(null); }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this sent-mirror connection? Scan history is also removed.')) return;
    try {
      const res = await apiFetch(`/api/accounting/ar/sent-mirror/connections/${id}`, { method: 'DELETE' });
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
      const res = await apiFetch(`/api/accounting/ar/sent-mirror/connections/${id}/log?limit=100`);
      const json = await res.json() as { data?: { items?: ScanLogEntry[] } };
      setLogEntries(json.data?.items ?? []);
    } catch { /* non-fatal */ }
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="px-6 py-4 border-b border-[var(--ff-border-light)] flex items-center justify-between">
          <div>
            <Link href="/accounting/ar" className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300 mb-1">
              <ChevronLeft className="h-3 w-3" /> Accounts Receivable
            </Link>
            <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">Sent-folder mirror</h1>
            <p className="text-sm text-[var(--ff-text-secondary)] mt-0.5">
              Watch a sent folder so invoices emailed outside the app still land in the evidence graph. PDFs that match a sealed invoice snapshot are linked, not duplicated.
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
          <div className="bg-[var(--ff-canvas-mid)] border border-[rgba(255,255,255,0.08)] rounded-xl overflow-hidden">
            <div className="px-6 py-4 border-b border-[rgba(255,255,255,0.06)]">
              <h2 className="text-base font-semibold text-[var(--ff-text-primary)]">Configured sent mailboxes</h2>
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
                <p className="text-slate-400 text-sm">No sent-folder mirrors connected yet.</p>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500 uppercase tracking-wider border-b border-[rgba(255,255,255,0.06)]">
                    <th className="px-6 py-3 font-medium">Mailbox</th>
                    <th className="px-6 py-3 font-medium">Status</th>
                    <th className="px-6 py-3 font-medium">Last scan</th>
                    <th className="px-6 py-3 text-right font-medium">Linked</th>
                    <th className="px-6 py-3 text-right font-medium">Captured</th>
                    <th className="px-6 py-3 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[rgba(255,255,255,0.04)]">
                  {connections.map(c => (
                    <tr key={c.id} className="hover:bg-white/5">
                      <td className="px-6 py-3">
                        <p className="text-slate-200 font-medium">{c.displayName}</p>
                        <p className="text-xs text-slate-500 font-mono">{c.accountEmail} · {c.sentFolder}</p>
                      </td>
                      <td className="px-6 py-3">
                        <StatusPill status={c.status} />
                        {c.lastError && (
                          <p className="mt-1 text-xs text-red-400 max-w-[240px] truncate" title={c.lastError}>{c.lastError}</p>
                        )}
                      </td>
                      <td className="px-6 py-3 text-slate-400 text-xs">{fmtDate(c.lastSuccessAt ?? c.lastScanAt)}</td>
                      <td className="px-6 py-3 text-right text-teal-300 font-medium">
                        <span className="inline-flex items-center gap-1"><Link2 className="h-3 w-3" />{c.messagesLinkedTotal}</span>
                      </td>
                      <td className="px-6 py-3 text-right text-slate-300 font-medium">{c.messagesCapturedTotal}</td>
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

        {addMode && (
          <div className="fixed inset-0 bg-black/60 z-40 flex items-center justify-center p-4" onClick={() => !saving && setAddMode(false)}>
            <div className="w-full max-w-lg bg-[var(--ff-canvas-mid)] border border-[rgba(255,255,255,0.08)] rounded-xl p-6" onClick={e => e.stopPropagation()}>
              <h3 className="text-base font-semibold text-[var(--ff-text-primary)] mb-4">Connect sent-folder IMAP mailbox</h3>
              <div className="space-y-3 text-sm">
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">Display name</label>
                  <input value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="Billing — Outbound"
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
                  <label className="text-xs text-slate-400 mb-1 block">Sent folder name</label>
                  <input value={sentFolder} onChange={e => setSentFolder(e.target.value)} placeholder="Sent"
                    className="w-full px-3 py-2 rounded bg-white/5 border border-[rgba(255,255,255,0.1)] text-slate-200 font-mono text-xs focus:outline-none focus:border-teal-500" />
                  <p className="mt-1 text-xs text-slate-500">Gmail: <span className="font-mono">[Gmail]/Sent Mail</span> · Outlook: <span className="font-mono">Sent Items</span> · iCloud: <span className="font-mono">Sent Messages</span>.</p>
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
                      <span className={`text-xs font-medium ${outcomeTone(e.outcome)}`}>
                        {e.outcome.replace(/_/g, ' ')}
                      </span>
                      <span className="text-xs text-slate-500">{fmtDate(e.scanned_at)}</span>
                    </div>
                    <p className="text-xs text-slate-300 truncate">{e.subject ?? '—'}</p>
                    <p className="text-xs text-slate-500 font-mono truncate">→ {e.recipient ?? '—'} · {e.attachment_count} att</p>
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
