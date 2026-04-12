/**
 * Delivery Notes List Page — redesigned with elevated design system
 */
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import { Truck, Plus, Loader2, XCircle, CheckCircle, Send } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface DeliveryNote {
  id: string; deliveryNoteNumber: string; customerName: string;
  deliveryDate: string; status: string; lineCount: number;
}

const STATUS: Record<string, { label: string; cls: string }> = {
  draft:      { label: 'Draft',      cls: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300' },
  dispatched: { label: 'Dispatched', cls: 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400' },
  delivered:  { label: 'Delivered',  cls: 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400' },
  cancelled:  { label: 'Cancelled',  cls: 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400' },
};

const TABS = ['all', 'draft', 'dispatched', 'delivered'] as const;

function formatDate(d: string): string {
  if (!d) return '—';
  return String(d).split('T')[0] ?? d;
}

export default function DeliveryNotesPage() {
  const router = useRouter();
  const [notes, setNotes] = useState<DeliveryNote[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<string>('all');
  const [patching, setPatching] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams();
      if (tab !== 'all') params.set('status', tab);
      const res = await apiFetch(`/api/accounting/delivery-notes?${params}`);
      const json = (await res.json()) as { data?: { notes?: DeliveryNote[]; total?: number } };
      const d = json.data ?? {};
      setNotes(d.notes ?? []); setTotal(d.total ?? 0);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load delivery notes');
    } finally { setLoading(false); }
  }, [tab]);

  useEffect(() => { void load(); }, [load]);

  const handleStatusChange = async (id: string, status: string) => {
    setPatching(id);
    try {
      await apiFetch('/api/accounting/delivery-notes', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status }),
      });
      void load();
    } finally { setPatching(null); }
  };

  const handleCancel = async (id: string) => {
    if (!window.confirm('Cancel this delivery note?')) return;
    setDeleting(id);
    try {
      await apiFetch('/api/accounting/delivery-notes', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      void load();
    } finally { setDeleting(null); }
  };

  const s = (n: DeliveryNote) => STATUS[n.status] ?? { label: n.status, cls: '' };

  return (
    <AppLayout>
      <div className="min-h-screen bg-slate-50 dark:bg-[var(--ff-bg-primary)]">
        <div className="relative overflow-hidden bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 px-6 py-8">
          <div className="absolute inset-0 opacity-[0.06]" style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, white 1px, transparent 0)', backgroundSize: '24px 24px' }} />
          <div className="absolute -top-12 right-8 w-72 h-72 bg-amber-500/10 rounded-full blur-3xl pointer-events-none" />
          <div className="relative z-10 flex items-center justify-between">
            <div>
              <p className="text-amber-400 text-xs font-semibold uppercase tracking-widest mb-1">Fulfilment</p>
              <h1 className="text-2xl font-bold text-white">Delivery Notes</h1>
              <p className="text-slate-400 text-sm mt-0.5">{total} {total === 1 ? 'delivery note' : 'delivery notes'}</p>
            </div>
            <button onClick={() => router.push('/accounting/delivery-notes/new')} className="flex items-center gap-2 px-4 py-2.5 bg-amber-500 hover:bg-amber-400 text-white rounded-xl text-sm font-semibold transition-colors shadow-lg shadow-amber-500/25">
              <Plus className="w-4 h-4" /> New Delivery Note
            </button>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {error && <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 px-4 py-3 rounded-xl text-sm">{error}</div>}

          <div className="flex gap-1 p-1 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 w-fit">
            {TABS.map(t => (
              <button key={t} onClick={() => setTab(t)} className={`px-3 py-1.5 text-xs font-medium rounded-lg capitalize transition-colors ${tab === t ? 'bg-amber-500 text-white shadow-sm' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}`}>
                {t === 'all' ? 'All' : STATUS[t]?.label ?? t}
              </button>
            ))}
          </div>

          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm">
            {loading ? (
              <div className="p-16 flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-slate-400" /></div>
            ) : notes.length === 0 ? (
              <div className="p-16 text-center">
                <div className="w-14 h-14 rounded-2xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center mx-auto mb-4"><Truck className="w-7 h-7 text-slate-400" /></div>
                <h3 className="text-base font-semibold text-slate-900 dark:text-white">No delivery notes found</h3>
                <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">Create a delivery note to start tracking fulfilment</p>
                <button onClick={() => router.push('/accounting/delivery-notes/new')} className="mt-5 px-4 py-2 bg-amber-500 hover:bg-amber-400 text-white text-sm font-semibold rounded-lg transition-colors">New Delivery Note</button>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800">
                  <tr>
                    {['DN #', 'Customer', 'Date', 'Lines', 'Status', ''].map((h, i) => (
                      <th key={i} className={`px-5 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider ${i === 3 ? 'text-center' : i === 5 ? 'text-right' : 'text-left'}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {notes.map(n => (
                    <tr key={n.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors cursor-pointer" onClick={() => router.push(`/accounting/delivery-notes/${n.id}`)}>
                      <td className="px-5 py-3.5 font-mono text-amber-500 font-semibold">{n.deliveryNoteNumber}</td>
                      <td className="px-5 py-3.5 text-slate-900 dark:text-slate-100 font-medium">{n.customerName}</td>
                      <td className="px-5 py-3.5 text-slate-500 dark:text-slate-400 text-xs">{formatDate(n.deliveryDate)}</td>
                      <td className="px-5 py-3.5 text-center text-slate-500 dark:text-slate-400">{n.lineCount ?? 0}</td>
                      <td className="px-5 py-3.5">
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${s(n).cls}`}>{s(n).label}</span>
                      </td>
                      <td className="px-4 py-3.5">
                        <div className="flex justify-end gap-1.5" onClick={e => e.stopPropagation()}>
                          {n.status === 'draft' && (
                            <button onClick={() => void handleStatusChange(n.id, 'dispatched')} disabled={patching === n.id} title="Mark Dispatched" className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/40 transition-colors disabled:opacity-50">
                              {patching === n.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />} Dispatch
                            </button>
                          )}
                          {n.status === 'dispatched' && (
                            <button onClick={() => void handleStatusChange(n.id, 'delivered')} disabled={patching === n.id} title="Mark Delivered" className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 transition-colors disabled:opacity-50">
                              {patching === n.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle className="h-3 w-3" />} Delivered
                            </button>
                          )}
                          {n.status !== 'cancelled' && n.status !== 'delivered' && (
                            <button onClick={() => void handleCancel(n.id)} disabled={deleting === n.id} title="Cancel" className="p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 text-slate-400 hover:text-red-500 transition-colors disabled:opacity-50">
                              {deleting === n.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />}
                            </button>
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
      </div>
    </AppLayout>
  );
}
