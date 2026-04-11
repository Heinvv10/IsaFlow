/**
 * Delivery Notes List Page
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import { Truck, Plus, Loader2, XCircle, CheckCircle, Send } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface DeliveryNote {
  id: string;
  deliveryNoteNumber: string;
  customerName: string;
  deliveryDate: string;
  status: string;
  lineCount: number;
}

const STATUS_BADGE: Record<string, string> = {
  draft: 'bg-gray-500/10 text-gray-400',
  dispatched: 'bg-blue-500/10 text-blue-400',
  delivered: 'bg-teal-500/10 text-teal-400',
  cancelled: 'bg-red-500/10 text-red-400',
};

const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  dispatched: 'Dispatched',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

const TABS = ['all', 'draft', 'dispatched', 'delivered'] as const;

function formatDate(d: string): string {
  if (!d) return '\u2014';
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
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (tab !== 'all') params.set('status', tab);
      const res = await apiFetch(`/api/accounting/delivery-notes?${params}`);
      const json = (await res.json()) as { data?: { notes?: DeliveryNote[]; total?: number } };
      const d = json.data ?? {};
      setNotes(d.notes ?? []);
      setTotal(d.total ?? 0);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load delivery notes');
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleStatusChange = async (id: string, status: string) => {
    setPatching(id);
    try {
      await apiFetch('/api/accounting/delivery-notes', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status }),
      });
      void load();
    } finally {
      setPatching(null);
    }
  };

  const handleCancel = async (id: string) => {
    if (!window.confirm('Cancel this delivery note?')) return;
    setDeleting(id);
    try {
      await apiFetch('/api/accounting/delivery-notes', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      void load();
    } finally {
      setDeleting(null);
    }
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10">
                <Truck className="h-6 w-6 text-teal-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">
                  Delivery Notes
                </h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  {total} delivery note{total !== 1 ? 's' : ''}
                </p>
              </div>
            </div>
            <button
              onClick={() => router.push('/accounting/delivery-notes/new')}
              className="flex items-center gap-1.5 px-4 py-2 bg-teal-600 hover:bg-teal-500 text-white rounded-lg text-sm"
            >
              <Plus className="h-4 w-4" /> New Delivery Note
            </button>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">
              {error}
            </div>
          )}

          {/* Tabs */}
          <div className="flex gap-1">
            {TABS.map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg capitalize ${
                  tab === t
                    ? 'bg-teal-600 text-white'
                    : 'text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-secondary)]'
                }`}
              >
                {t === 'all' ? 'All' : STATUS_LABEL[t] ?? t}
              </button>
            ))}
          </div>

          {/* Table */}
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            {loading ? (
              <div className="p-8 text-center">
                <Loader2 className="h-6 w-6 animate-spin text-[var(--ff-text-tertiary)] mx-auto" />
              </div>
            ) : notes.length === 0 ? (
              <div className="p-8 text-center text-[var(--ff-text-secondary)]">
                No delivery notes found
              </div>
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)]">
                    <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">DN #</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Customer</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Date</th>
                    <th className="px-4 py-3 text-center text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Lines</th>
                    <th className="px-4 py-3 text-center text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Status</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--ff-border-light)]">
                  {notes.map((n) => (
                    <tr
                      key={n.id}
                      className="hover:bg-[var(--ff-bg-tertiary)] transition-colors cursor-pointer"
                      onClick={() => router.push(`/accounting/delivery-notes/${n.id}`)}
                    >
                      <td className="px-4 py-3 text-sm font-mono text-teal-400">{n.deliveryNoteNumber}</td>
                      <td className="px-4 py-3 text-sm text-[var(--ff-text-primary)]">{n.customerName}</td>
                      <td className="px-4 py-3 text-sm text-[var(--ff-text-secondary)]">{formatDate(n.deliveryDate)}</td>
                      <td className="px-4 py-3 text-sm text-center text-[var(--ff-text-secondary)]">{n.lineCount ?? 0}</td>
                      <td className="px-4 py-3 text-center">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_BADGE[n.status] ?? ''}`}>
                          {STATUS_LABEL[n.status] ?? n.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div
                          className="flex justify-end gap-1"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {n.status === 'draft' && (
                            <button
                              onClick={() => void handleStatusChange(n.id, 'dispatched')}
                              disabled={patching === n.id}
                              title="Mark Dispatched"
                              className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 disabled:opacity-50"
                            >
                              {patching === n.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Send className="h-3.5 w-3.5" />
                              )}
                              Dispatch
                            </button>
                          )}
                          {n.status === 'dispatched' && (
                            <button
                              onClick={() => void handleStatusChange(n.id, 'delivered')}
                              disabled={patching === n.id}
                              title="Mark Delivered"
                              className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-teal-500/10 hover:bg-teal-500/20 text-teal-400 disabled:opacity-50"
                            >
                              {patching === n.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <CheckCircle className="h-3.5 w-3.5" />
                              )}
                              Delivered
                            </button>
                          )}
                          {n.status !== 'cancelled' && n.status !== 'delivered' && (
                            <button
                              onClick={() => void handleCancel(n.id)}
                              disabled={deleting === n.id}
                              title="Cancel"
                              className="p-1.5 rounded hover:bg-red-500/10 text-red-400 disabled:opacity-50"
                            >
                              {deleting === n.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <XCircle className="h-3.5 w-3.5" />
                              )}
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
