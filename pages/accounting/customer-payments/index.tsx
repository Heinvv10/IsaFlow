/**
 * Customer Payments List Page
 * PRD-060 Phase 3: Accounts Receivable
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import {
  Wallet, Plus, Loader2, AlertCircle, ChevronRight, Filter,
} from 'lucide-react';
import { ExportCSVButton } from '@/components/shared/ExportCSVButton';
import type { CustomerPayment, CustomerPaymentStatus } from '@/modules/accounting/types/ar.types';

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'All Statuses' },
  { value: 'draft', label: 'Draft' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'reconciled', label: 'Reconciled' },
  { value: 'cancelled', label: 'Cancelled' },
];

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    draft: 'bg-gray-500/20 text-gray-400',
    confirmed: 'bg-emerald-500/20 text-emerald-400',
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

export default function CustomerPaymentsPage() {
  const [payments, setPayments] = useState<CustomerPayment[]>([]);
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
      const res = await fetch(`/api/accounting/customer-payments?${params}`);
      const json = await res.json();
      const payload = json.data || json;
      setPayments(payload.payments || []);
      setTotal(payload.total || 0);
    } catch {
      setError('Failed to load customer payments');
    } finally {
      setIsLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => { loadPayments(); }, [loadPayments]);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-emerald-500/10">
                <Wallet className="h-6 w-6 text-emerald-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Customer Payments</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  {total} payment{total !== 1 ? 's' : ''} recorded
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <ExportCSVButton endpoint="/api/accounting/customer-payments-export" filenamePrefix="customer-payments" params={{ status: statusFilter }} label="Export CSV" />
              <Link
                href="/accounting/customer-payments/new"
                className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors text-sm font-medium"
              >
                <Plus className="h-4 w-4" /> Record Payment
              </Link>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {/* Filters */}
          <div className="flex items-center gap-3">
            <Filter className="h-4 w-4 text-[var(--ff-text-tertiary)]" />
            <select
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value)}
              className="ff-select text-sm"
            >
              {STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>

          {/* Error */}
          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">
              <AlertCircle className="h-4 w-4" /> {error}
            </div>
          )}

          {/* Loading */}
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-emerald-500" />
            </div>
          ) : payments.length === 0 ? (
            <div className="text-center py-12 text-[var(--ff-text-secondary)]">
              No customer payments found
            </div>
          ) : (
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--ff-border-light)]">
                    <th className="text-left px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Payment #</th>
                    <th className="text-left px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Client</th>
                    <th className="text-left px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Date</th>
                    <th className="text-right px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Amount</th>
                    <th className="text-left px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Method</th>
                    <th className="text-left px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Status</th>
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map(p => (
                    <tr key={p.id} className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)] transition-colors">
                      <td className="px-4 py-3 font-mono text-[var(--ff-text-primary)]">
                        <Link href={`/accounting/customer-payments/${p.id}`} className="hover:text-emerald-400 transition-colors">
                          {p.paymentNumber}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-[var(--ff-text-primary)]">{p.clientName || '—'}</td>
                      <td className="px-4 py-3 text-[var(--ff-text-secondary)]">
                        {new Date(p.paymentDate).toLocaleDateString('en-ZA')}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-[var(--ff-text-primary)]">
                        {formatCurrency(p.totalAmount)}
                      </td>
                      <td className="px-4 py-3 text-[var(--ff-text-secondary)] uppercase text-xs">{p.paymentMethod}</td>
                      <td className="px-4 py-3"><StatusBadge status={p.status} /></td>
                      <td className="px-4 py-3 text-right">
                        <Link href={`/accounting/customer-payments/${p.id}`}>
                          <ChevronRight className="h-4 w-4 text-[var(--ff-text-tertiary)] hover:text-emerald-400" />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
