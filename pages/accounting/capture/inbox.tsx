/**
 * Capture Inbox — PRD-05 Phase 1
 * Pending capture events (received / extracting / extracted / failed).
 * Polls every 10s. Row-click opens a right-side slide-out panel.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { Loader2, AlertCircle, Mail, Copy, Check, ChevronRight, RefreshCw, X } from 'lucide-react';
import {
  CaptureInboxPanel, StatusBadge, CHANNEL_ICONS, fmtDate, fmtZAR,
  type CaptureEventRow, type InboxAddress,
} from '@/components/accounting/capture/CaptureInboxPanel';

const PENDING_STATUSES = ['received', 'extracting', 'extracted', 'failed'];

export default function CaptureInboxPage() {
  const [events, setEvents] = useState<CaptureEventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showProcessed, setShowProcessed] = useState(false);
  const [selected, setSelected] = useState<CaptureEventRow | null>(null);
  const [inboxAddr, setInboxAddr] = useState<InboxAddress | null>(null);
  const [copied, setCopied] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [posting, setPosting] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function showToast(msg: string, ok: boolean) { setToast({ msg, ok }); }
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const loadEvents = useCallback(async () => {
    try {
      const qs = showProcessed ? '' : '?status=received,extracting,extracted,failed';
      const res = await apiFetch(`/api/accounting/capture/inbox${qs}`);
      const json = await res.json() as { data?: { events?: CaptureEventRow[] }; error?: string };
      if (!res.ok) { setError(json.error ?? 'Failed to load inbox'); return; }
      setEvents(json.data?.events ?? []);
      setError('');
    } catch {
      setError('Network error loading inbox');
    } finally {
      setLoading(false);
    }
  }, [showProcessed]);

  const loadInboxAddress = useCallback(async () => {
    try {
      const res = await apiFetch('/api/accounting/capture/inbox-address');
      if (res.ok) {
        const json = await res.json() as { data?: { inbox?: InboxAddress } };
        setInboxAddr(json.data?.inbox ?? null);
      }
    } catch { /* non-critical */ }
  }, []);

  useEffect(() => {
    setLoading(true);
    void Promise.all([loadEvents(), loadInboxAddress()]);
  }, [loadEvents, loadInboxAddress]);

  // Poll every 10s
  useEffect(() => {
    intervalRef.current = setInterval(() => { void loadEvents(); }, 10_000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [loadEvents]);

  async function handlePost(id: string) {
    setPosting(true);
    try {
      const res = await apiFetch(`/api/accounting/capture/${id}/post`, { method: 'POST', body: '{}' });
      const json = await res.json() as {
        data?: { invoice?: { invoiceNumber?: string }; reason?: string };
        error?: { message?: string } | string;
      };
      if (!res.ok) {
        const msg = typeof json.error === 'string' ? json.error : json.error?.message ?? 'Post failed';
        showToast(msg, false); return;
      }
      const inv = json.data?.invoice?.invoiceNumber ?? '';
      const reason = json.data?.reason;
      const note = inv ? `Invoice ${inv} created` : (reason ? `Routed to review: ${reason}` : 'Posted successfully');
      showToast(note, true);
      setSelected(null);
      void loadEvents();
    } catch { showToast('Network error', false); }
    finally { setPosting(false); }
  }

  const handlePostExpense = useCallback(async (eventId: string, employeeId?: string) => {
    setPosting(true);
    try {
      const res = await apiFetch(`/api/accounting/capture/${eventId}/post-expense`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ employeeId }),
      });
      const json = await res.json() as { error?: { message?: string } | string };
      if (!res.ok) {
        const msg = typeof json.error === 'string' ? json.error : (json.error as { message?: string } | undefined)?.message ?? 'Failed to post expense';
        showToast(msg, false);
      } else {
        showToast('Posted as expense', true);
        setSelected(null);
        void loadEvents();
      }
    } catch { showToast('Network error', false); }
    finally { setPosting(false); }
  }, [loadEvents]);

  async function handleDiscard(id: string, reason?: string) {
    setDiscarding(true);
    try {
      const body = reason ? JSON.stringify({ reason }) : '{}';
      const res = await apiFetch(`/api/accounting/capture/${id}/discard`, { method: 'POST', body });
      const json = await res.json() as { error?: { message?: string } | string };
      if (!res.ok) {
        const msg = typeof json.error === 'string' ? json.error : json.error?.message ?? 'Discard failed';
        showToast(msg, false); return;
      }
      showToast('Discarded', true);
      setSelected(null);
      void loadEvents();
    } catch { showToast('Network error', false); }
    finally { setDiscarding(false); }
  }

  async function copyAddress() {
    if (!inboxAddr?.address) return;
    await navigator.clipboard.writeText(inboxAddr.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const visible = showProcessed ? events : events.filter(e => PENDING_STATUSES.includes(e.status));

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="px-6 py-4 border-b border-[var(--ff-border-light)] flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">Capture Inbox</h1>
            <p className="text-sm text-[var(--ff-text-secondary)] mt-0.5">Captured documents awaiting review</p>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-slate-400 cursor-pointer select-none">
              <input type="checkbox" checked={showProcessed} onChange={e => setShowProcessed(e.target.checked)}
                className="rounded border-slate-600 bg-transparent" />
              Show processed
            </label>
            <button onClick={() => { setLoading(true); void loadEvents(); }}
              className="p-2 rounded text-slate-500 hover:text-slate-200 hover:bg-white/5 transition-colors" title="Refresh">
              <RefreshCw className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Toast */}
        {toast && (
          <div className={`mx-6 mt-3 flex items-center justify-between p-3 rounded-lg text-sm ${toast.ok ? 'bg-green-900/40 text-green-300' : 'bg-red-900/40 text-red-300'}`}>
            <span className="flex items-center gap-2">
              {toast.ok ? <Check className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
              {toast.msg}
            </span>
            <button onClick={() => setToast(null)}><X className="h-3.5 w-3.5" /></button>
          </div>
        )}

        {/* Content */}
        <div className="px-4 py-4">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
            </div>
          ) : error ? (
            <div className="flex items-center gap-2 text-red-400 py-10 justify-center">
              <AlertCircle className="h-5 w-5" /><span>{error}</span>
            </div>
          ) : visible.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center mb-4">
                <Mail className="h-8 w-8 text-slate-600" />
              </div>
              <p className="text-slate-400 font-medium mb-2">No pending captures</p>
              {inboxAddr && (
                <p className="text-slate-500 text-sm flex items-center gap-2 flex-wrap justify-center">
                  Forward slips to
                  <span className="font-mono text-slate-300 bg-white/5 px-2 py-0.5 rounded">{inboxAddr.address}</span>
                  <button onClick={() => void copyAddress()} className="text-slate-500 hover:text-teal-400 transition-colors">
                    {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </button>
                </p>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-[rgba(255,255,255,0.06)]">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[rgba(255,255,255,0.06)] text-xs text-slate-500 uppercase tracking-wider">
                    <th className="px-4 py-3 text-left font-medium">Channel</th>
                    <th className="px-4 py-3 text-left font-medium">Received</th>
                    <th className="px-4 py-3 text-left font-medium">Sender</th>
                    <th className="px-4 py-3 text-left font-medium">Vendor</th>
                    <th className="px-4 py-3 text-left font-medium">Reference</th>
                    <th className="px-4 py-3 text-right font-medium">Amount</th>
                    <th className="px-4 py-3 text-left font-medium">Status</th>
                    <th className="px-4 py-3 text-left font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[rgba(255,255,255,0.04)]">
                  {visible.map(ev => (
                    <tr key={ev.eventId} onClick={() => setSelected(ev)}
                      className="cursor-pointer hover:bg-white/5 transition-colors group">
                      <td className="px-4 py-3 text-slate-400">{CHANNEL_ICONS[ev.channel]}</td>
                      <td className="px-4 py-3 text-slate-300 whitespace-nowrap">{fmtDate(ev.receivedAt)}</td>
                      <td className="px-4 py-3 text-slate-400 max-w-[160px] truncate">{ev.sender ?? '—'}</td>
                      <td className="px-4 py-3 text-slate-300 font-medium">{ev.vendorName ?? '—'}</td>
                      <td className="px-4 py-3 text-slate-400 font-mono text-xs">{ev.referenceNumber ?? '—'}</td>
                      <td className="px-4 py-3 text-right text-slate-300">{fmtZAR(ev.totalAmount)}</td>
                      <td className="px-4 py-3"><StatusBadge status={ev.status} error={ev.error} /></td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          {ev.status === 'extracted' && (
                            <button onClick={e => { e.stopPropagation(); void handlePost(ev.eventId); }}
                              className="px-2.5 py-1 bg-teal-700 hover:bg-teal-600 text-white rounded text-xs font-medium">
                              Post
                            </button>
                          )}
                          <button onClick={e => { e.stopPropagation(); setSelected(ev); }}
                            className="p-1.5 rounded text-slate-500 hover:text-slate-200 hover:bg-white/10">
                            <ChevronRight className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {selected && (
        <>
          <div className="fixed inset-0 z-40 bg-black/30" onClick={() => setSelected(null)} />
          <CaptureInboxPanel
            event={selected} onClose={() => setSelected(null)}
            onPost={handlePost} onDiscard={handleDiscard}
            onPostExpense={handlePostExpense}
            posting={posting} discarding={discarding}
          />
        </>
      )}
    </AppLayout>
  );
}
