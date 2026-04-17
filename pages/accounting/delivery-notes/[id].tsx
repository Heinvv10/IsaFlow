/**
 * Delivery Note Detail Page
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import { Truck, Loader2, ArrowLeft, Send, CheckCircle, XCircle } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface DeliveryNoteLine {
  id: string;
  description: string;
  quantity: number;
  unit: string | null;
}

interface DeliveryNote {
  id: string;
  deliveryNoteNumber: string;
  customerName: string;
  customerId: string;
  salesOrderId: string | null;
  invoiceId: string | null;
  deliveryDate: string;
  status: string;
  deliveryAddress: string | null;
  notes: string | null;
  createdAt: string;
  lines?: DeliveryNoteLine[];
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

function formatDate(d: string): string {
  if (!d) return '\u2014';
  return String(d).split('T')[0] ?? d;
}

export default function DeliveryNoteDetailPage() {
  const router = useRouter();
  const { id } = router.query;

  const [note, setNote] = useState<DeliveryNote | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [patching, setPatching] = useState(false);

  const load = useCallback(async () => {
    if (!id || typeof id !== 'string') return;
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch(`/api/accounting/delivery-notes?id=${id}`);
      const json = (await res.json()) as { data?: DeliveryNote; error?: { message?: string } };
      if (!res.ok) {
        setError(json?.error?.message ?? 'Not found');
        return;
      }
      setNote(json.data ?? null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load delivery note');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleStatusChange = async (status: string) => {
    if (!note) return;
    setPatching(true);
    try {
      await apiFetch('/api/accounting/delivery-notes', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: note.id, status }),
      });
      void load();
    } finally {
      setPatching(false);
    }
  };

  const handleCancel = async () => {
    if (!note || !window.confirm('Cancel this delivery note?')) return;
    setPatching(true);
    try {
      await apiFetch('/api/accounting/delivery-notes', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: note.id }),
      });
      await router.push('/accounting/delivery-notes');
    } finally {
      setPatching(false);
    }
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <button
                onClick={() => router.push('/accounting/delivery-notes')}
                className="p-1.5 rounded hover:bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-secondary)]"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
              <div className="p-2 rounded-lg bg-teal-500/10">
                <Truck className="h-6 w-6 text-teal-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">
                  {note ? note.deliveryNoteNumber : 'Delivery Note'}
                </h1>
                {note && (
                  <p className="text-sm text-[var(--ff-text-secondary)]">{note.customerName}</p>
                )}
              </div>
            </div>

            {note && (
              <div className="flex items-center gap-2">
                <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${STATUS_BADGE[note.status] ?? ''}`}>
                  {STATUS_LABEL[note.status] ?? note.status}
                </span>
                {note.status === 'draft' && (
                  <button
                    onClick={() => void handleStatusChange('dispatched')}
                    disabled={patching}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-teal-600 hover:bg-teal-500 text-white rounded-lg disabled:opacity-50"
                  >
                    {patching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                    Dispatch
                  </button>
                )}
                {note.status === 'dispatched' && (
                  <button
                    onClick={() => void handleStatusChange('delivered')}
                    disabled={patching}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-teal-600 hover:bg-teal-500 text-white rounded-lg disabled:opacity-50"
                  >
                    {patching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle className="h-3.5 w-3.5" />}
                    Mark Delivered
                  </button>
                )}
                {note.status !== 'cancelled' && note.status !== 'delivered' && (
                  <button
                    onClick={() => void handleCancel()}
                    disabled={patching}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-red-500/30 hover:bg-red-500/10 text-red-400 rounded-lg disabled:opacity-50"
                  >
                    <XCircle className="h-3.5 w-3.5" />
                    Cancel
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="p-6 max-w-3xl space-y-6">
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded text-sm">
              {error}
            </div>
          )}

          {loading ? (
            <div className="p-8 text-center">
              <Loader2 className="h-6 w-6 animate-spin text-[var(--ff-text-tertiary)] mx-auto" />
            </div>
          ) : note ? (
            <>
              {/* Details card */}
              <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5">
                <h2 className="text-sm font-semibold text-[var(--ff-text-primary)] uppercase tracking-wide mb-4">
                  Delivery Details
                </h2>
                <div className="grid grid-cols-2 gap-x-8 gap-y-3 text-sm">
                  <div>
                    <span className="text-[var(--ff-text-secondary)]">Customer</span>
                    <p className="text-[var(--ff-text-primary)] font-medium">{note.customerName}</p>
                  </div>
                  <div>
                    <span className="text-[var(--ff-text-secondary)]">Delivery Date</span>
                    <p className="text-[var(--ff-text-primary)]">{formatDate(note.deliveryDate)}</p>
                  </div>
                  {note.salesOrderId && (
                    <div>
                      <span className="text-[var(--ff-text-secondary)]">Sales Order</span>
                      <button
                        onClick={() => router.push(`/accounting/customer-sales-orders/${note.salesOrderId}`)}
                        className="block text-blue-400 hover:underline"
                      >
                        View order
                      </button>
                    </div>
                  )}
                  {note.invoiceId && (
                    <div>
                      <span className="text-[var(--ff-text-secondary)]">Invoice</span>
                      <button
                        onClick={() => router.push(`/accounting/customer-invoices/${note.invoiceId}`)}
                        className="block text-blue-400 hover:underline"
                      >
                        View invoice
                      </button>
                    </div>
                  )}
                  {note.deliveryAddress && (
                    <div className="col-span-2">
                      <span className="text-[var(--ff-text-secondary)]">Delivery Address</span>
                      <p className="text-[var(--ff-text-primary)] whitespace-pre-wrap">{note.deliveryAddress}</p>
                    </div>
                  )}
                  {note.notes && (
                    <div className="col-span-2">
                      <span className="text-[var(--ff-text-secondary)]">Notes</span>
                      <p className="text-[var(--ff-text-primary)] whitespace-pre-wrap">{note.notes}</p>
                    </div>
                  )}
                </div>
              </div>

              {/* Line items */}
              <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
                <div className="px-5 py-3 border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)]">
                  <h2 className="text-sm font-semibold text-[var(--ff-text-primary)] uppercase tracking-wide">
                    Line Items
                  </h2>
                </div>
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-[var(--ff-border-light)]">
                      <th className="px-4 py-2.5 text-left text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">Description</th>
                      <th className="px-4 py-2.5 text-right text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">Qty</th>
                      <th className="px-4 py-2.5 text-left text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">Unit</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--ff-border-light)]">
                    {(note.lines ?? []).map((line) => (
                      <tr key={line.id} className="hover:bg-teal-500/[0.04]">
                        <td className="px-4 py-2.5 text-sm text-[var(--ff-text-primary)]">{line.description}</td>
                        <td className="px-4 py-2.5 text-sm text-right font-mono tabular-nums text-[var(--ff-text-primary)]">
                          {Number(line.quantity).toLocaleString('en-ZA')}
                        </td>
                        <td className="px-4 py-2.5 text-sm text-[var(--ff-text-secondary)]">{line.unit ?? ''}</td>
                      </tr>
                    ))}
                    {!note.lines?.length && (
                      <tr>
                        <td colSpan={3} className="px-4 py-4 text-center text-sm text-[var(--ff-text-secondary)]">
                          No line items
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <p className="text-xs text-[var(--ff-text-tertiary)]">
                Created {formatDate(note.createdAt)}
              </p>
            </>
          ) : null}
        </div>
      </div>
    </AppLayout>
  );
}
