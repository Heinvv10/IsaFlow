/**
 * Supplier Batch Payments Page
 * Phase 1 Sage Alignment: Bulk supplier payment processing
 */

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { Layers, Plus, Check, Zap, Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface Batch {
  id: string; batchNumber: string; batchDate: string; totalAmount: number;
  paymentCount: number; paymentMethod: string; status: string;
}

const fmt = (n: number) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

const STATUS_BADGE: Record<string, string> = {
  draft: 'bg-gray-500/10 text-gray-400',
  approved: 'bg-blue-500/10 text-blue-400',
  processed: 'bg-teal-500/10 text-teal-400',
  cancelled: 'bg-red-500/10 text-red-400',
};

export default function BatchPaymentsPage() {
  const [items, setItems] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    const res = await apiFetch('/api/accounting/batch-payments', { credentials: 'include' });
    const json = await res.json();
    setItems(json.data?.items || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const doAction = async (action: string, id: string) => {
    setBusy(id);
    await apiFetch('/api/accounting/batch-payments-action', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'include', body: JSON.stringify({ action, id }),
    });
    await load(); setBusy('');
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-indigo-500/10"><Layers className="h-6 w-6 text-indigo-500" /></div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Batch Payments</h1>
            </div>
            <Link href="/accounting/batch-payments/new" className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium">
              <Plus className="h-4 w-4" /> New Batch
            </Link>
          </div>
        </div>

        <div className="p-6">
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
                <th className="px-4 py-3">Batch Number</th><th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Payments</th><th className="px-4 py-3 text-right">Total</th>
                <th className="px-4 py-3">Method</th><th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Actions</th>
              </tr></thead>
              <tbody>
                {loading && <tr><td colSpan={7} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">Loading...</td></tr>}
                {!loading && items.length === 0 && <tr><td colSpan={7} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">No batch payments</td></tr>}
                {items.map(item => (
                  <tr key={item.id} className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50">
                    <td className="px-4 py-3 text-[var(--ff-text-primary)] font-medium">
                      <Link href={`/accounting/batch-payments/${item.id}`} className="hover:text-indigo-400 transition-colors">
                        {item.batchNumber}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{item.batchDate?.split('T')[0]}</td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{item.paymentCount}</td>
                    <td className="px-4 py-3 text-right text-[var(--ff-text-primary)]">{fmt(item.totalAmount)}</td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)] uppercase">{item.paymentMethod}</td>
                    <td className="px-4 py-3"><span className={`px-2 py-0.5 rounded text-xs font-medium ${STATUS_BADGE[item.status] || ''}`}>{item.status}</span></td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        {item.status === 'draft' && (
                          <button onClick={() => doAction('approve', item.id)} disabled={busy === item.id} className="p-1 text-blue-400 hover:text-blue-300" title="Approve">
                            {busy === item.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                          </button>
                        )}
                        {item.status === 'approved' && (
                          <button onClick={() => doAction('process', item.id)} disabled={busy === item.id} className="p-1 text-teal-400 hover:text-teal-300" title="Process">
                            {busy === item.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
