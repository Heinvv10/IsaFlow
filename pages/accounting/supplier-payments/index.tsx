/**
 * Supplier Payments List Page
 * PRD-060 Phase 2: Payment runs & allocations
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import {
  Wallet, Plus, Loader2, AlertCircle, ChevronRight, Filter,
} from 'lucide-react';
import type { SupplierPayment, PaymentStatus } from '@/modules/accounting/types/ap.types';

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'All Statuses' },
  { value: 'draft', label: 'Draft' },
  { value: 'approved', label: 'Approved' },
  { value: 'processed', label: 'Processed' },
  { value: 'reconciled', label: 'Reconciled' },
  { value: 'cancelled', label: 'Cancelled' },
];

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    draft: 'bg-gray-500/20 text-gray-400',
    approved: 'bg-amber-500/20 text-amber-400',
    processed: 'bg-emerald-500/20 text-emerald-400',
    reconciled: 'bg-blue-500/20 text-blue-400',
    cancelled: 'bg-red-500/20 text-red-400',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${colors[status] || 'bg-gray-500/20 text-gray-400'}`}>
      {status}
    </span>
  );
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(amount);
}

export default function SupplierPaymentsPage() {
  const [payments, setPayments] = useState<SupplierPayment[]>([]);
  const [total, setTotal] = useState(0);
  const [statusFilter, setStatusFilter] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  const loadPayments = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      const res = await fetch(`/api/accounting/supplier-payments?${params}`);
      const json = await res.json();
      const payload = json.data || json;
      setPayments(payload.payments || []);
      setTotal(payload.total || 0);
    } catch {
      setError('Failed to load payments');
    } finally {
      setIsLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => { loadPayments(); }, [loadPayments]);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-emerald-500/10">
                <Wallet className="h-6 w-6 text-emerald-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Supplier Payments</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  Payment runs, allocations & GL posting
                </p>
              </div>
            </div>
            <Link
              href="/accounting/supplier-payments/new"
              className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors text-sm font-medium"
            >
              <Plus className="h-4 w-4" />
              New Payment
            </Link>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {/* Filters */}
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <Filter className="h-4 w-4 text-[var(--ff-text-tertiary)]" />
              <select
                value={statusFilter}
                onChange={e => setStatusFilter(e.target.value)}
                className="ff-select text-sm"
              >
                {STATUS_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
            <span className="text-sm text-[var(--ff-text-secondary)]">{total} payment{total !== 1 ? 's' : ''}</span>
          </div>

          {error && (
            <div className="flex items-center gap-2 p-3 bg-red-500/10 rounded-lg text-red-400 text-sm">
              <AlertCircle className="h-4 w-4" />{error}
            </div>
          )}

          {/* Table */}
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            {isLoading ? (
              <div className="p-8 text-center">
                <Loader2 className="h-6 w-6 animate-spin text-[var(--ff-text-tertiary)] mx-auto" />
              </div>
            ) : payments.length === 0 ? (
              <div className="p-8 text-center">
                <Wallet className="h-8 w-8 text-[var(--ff-text-tertiary)] mx-auto mb-2" />
                <p className="text-[var(--ff-text-secondary)]">No supplier payments found</p>
              </div>
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)]">
                    <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Payment #</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Supplier</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Date</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Amount</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Method</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Status</th>
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--ff-border-light)]">
                  {payments.map(p => (
                    <tr key={p.id} className="hover:bg-[var(--ff-bg-tertiary)] transition-colors">
                      <td className="px-4 py-3 text-sm font-medium text-[var(--ff-text-primary)]">{p.paymentNumber}</td>
                      <td className="px-4 py-3 text-sm text-[var(--ff-text-secondary)]">{p.supplierName || '-'}</td>
                      <td className="px-4 py-3 text-sm text-[var(--ff-text-secondary)]">{p.paymentDate}</td>
                      <td className="px-4 py-3 text-sm text-right font-mono text-[var(--ff-text-primary)]">{formatCurrency(p.totalAmount)}</td>
                      <td className="px-4 py-3 text-sm text-[var(--ff-text-secondary)] uppercase">{p.paymentMethod}</td>
                      <td className="px-4 py-3"><StatusBadge status={p.status} /></td>
                      <td className="px-4 py-3 text-right">
                        <Link href={`/accounting/supplier-payments/${p.id}`} className="text-emerald-600 hover:text-emerald-700">
                          <ChevronRight className="h-4 w-4" />
                        </Link>
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
