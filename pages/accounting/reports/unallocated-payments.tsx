/**
 * Unallocated Supplier Payments Report
 * Sage Parity: Suppliers > Reports > Unallocated Payments
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { AlertCircle, Loader2 } from 'lucide-react';

const fmt = (n: number) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

interface Payment { id: string; paymentNumber: string; supplierName: string; date: string; amount: number; allocatedAmount: number; }

export default function UnallocatedPaymentsReport() {
  const [items, setItems] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const res = await fetch('/api/accounting/supplier-payments?unallocated=true', { credentials: 'include' });
    const json = await res.json();
    setItems(json.data?.items || json.data || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const totalUnalloc = items.reduce((s, p) => s + (p.amount - p.allocatedAmount), 0);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-amber-500/10"><AlertCircle className="h-6 w-6 text-amber-500" /></div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Unallocated Supplier Payments</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">Payments not fully matched to invoices</p>
              </div>
            </div>
            <Link href="/accounting/supplier-allocations"
              className="px-4 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 text-sm font-medium">
              Allocate Payments
            </Link>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {!loading && items.length > 0 && (
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4 inline-block">
              <p className="text-xs text-[var(--ff-text-tertiary)] uppercase">Total Unallocated</p>
              <p className="text-xl font-bold text-amber-400 font-mono">{fmt(totalUnalloc)}</p>
            </div>
          )}

          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            {loading ? (
              <div className="p-8 text-center"><Loader2 className="h-6 w-6 animate-spin text-[var(--ff-text-tertiary)] mx-auto" /></div>
            ) : items.length === 0 ? (
              <div className="p-8 text-center text-[var(--ff-text-tertiary)]">All payments are fully allocated</div>
            ) : (
              <table className="w-full text-sm">
                <thead><tr className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)]">
                  <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Payment No</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Supplier</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Date</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Total</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Allocated</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Unallocated</th>
                </tr></thead>
                <tbody className="divide-y divide-[var(--ff-border-light)]">
                  {items.map(p => (
                    <tr key={p.id} className="hover:bg-[var(--ff-bg-tertiary)]">
                      <td className="px-4 py-3 font-medium text-[var(--ff-text-primary)]">
                        <Link href={`/accounting/supplier-payments/${p.id}`} className="hover:text-orange-400">{p.paymentNumber}</Link>
                      </td>
                      <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{p.supplierName}</td>
                      <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{p.date?.split('T')[0]}</td>
                      <td className="px-4 py-3 text-right font-mono text-[var(--ff-text-primary)]">{fmt(p.amount)}</td>
                      <td className="px-4 py-3 text-right font-mono text-emerald-400">{fmt(p.allocatedAmount)}</td>
                      <td className="px-4 py-3 text-right font-mono font-bold text-amber-400">{fmt(p.amount - p.allocatedAmount)}</td>
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
