/**
 * Supplier Invoices List Page
 * PRD-060 Phase 2: Accounts Payable
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import {
  Receipt, Plus, Loader2, AlertCircle, ChevronRight, Filter,
} from 'lucide-react';
import type { SupplierInvoice, SupplierInvoiceStatus } from '@/modules/accounting/types/ap.types';

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'All Statuses' },
  { value: 'draft', label: 'Draft' },
  { value: 'pending_approval', label: 'Pending Approval' },
  { value: 'approved', label: 'Approved' },
  { value: 'partially_paid', label: 'Partially Paid' },
  { value: 'paid', label: 'Paid' },
  { value: 'disputed', label: 'Disputed' },
  { value: 'cancelled', label: 'Cancelled' },
];

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    draft: 'bg-gray-500/20 text-gray-400',
    pending_approval: 'bg-amber-500/20 text-amber-400',
    approved: 'bg-blue-500/20 text-blue-400',
    partially_paid: 'bg-purple-500/20 text-purple-400',
    paid: 'bg-emerald-500/20 text-emerald-400',
    disputed: 'bg-red-500/20 text-red-400',
    cancelled: 'bg-gray-500/20 text-gray-500',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${colors[status] || 'bg-gray-500/20 text-gray-400'}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

function MatchBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    unmatched: 'bg-gray-500/20 text-gray-400',
    po_matched: 'bg-amber-500/20 text-amber-400',
    grn_matched: 'bg-blue-500/20 text-blue-400',
    fully_matched: 'bg-emerald-500/20 text-emerald-400',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${colors[status] || 'bg-gray-500/20 text-gray-400'}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(amount);
}

function formatDate(dateStr: string | undefined): string {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function SupplierInvoicesPage() {
  const [invoices, setInvoices] = useState<SupplierInvoice[]>([]);
  const [total, setTotal] = useState(0);
  const [statusFilter, setStatusFilter] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  const loadInvoices = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      const res = await fetch(`/api/accounting/supplier-invoices?${params}`);
      const json = await res.json();
      const payload = json.data || json;
      setInvoices(payload.invoices || []);
      setTotal(payload.total || 0);
    } catch (err) {
      setError('Failed to load supplier invoices');
    } finally {
      setIsLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => { loadInvoices(); }, [loadInvoices]);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-emerald-500/10">
                <Receipt className="h-6 w-6 text-emerald-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Supplier Invoices</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  Manage supplier invoices, 3-way matching & approvals
                </p>
              </div>
            </div>
            <Link
              href="/accounting/supplier-invoices/new"
              className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors text-sm font-medium"
            >
              <Plus className="h-4 w-4" />
              New Invoice
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
            <span className="text-sm text-[var(--ff-text-secondary)]">{total} invoice{total !== 1 ? 's' : ''}</span>
          </div>

          {/* Error */}
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
            ) : invoices.length === 0 ? (
              <div className="p-8 text-center">
                <Receipt className="h-8 w-8 text-[var(--ff-text-tertiary)] mx-auto mb-2" />
                <p className="text-[var(--ff-text-secondary)]">No supplier invoices found</p>
              </div>
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)]">
                    <th className="ff-table-header px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Invoice #</th>
                    <th className="ff-table-header px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Supplier</th>
                    <th className="ff-table-header px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Reference</th>
                    <th className="ff-table-header px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Date</th>
                    <th className="ff-table-header px-4 py-3 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Total</th>
                    <th className="ff-table-header px-4 py-3 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Outstanding</th>
                    <th className="ff-table-header px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Status</th>
                    <th className="ff-table-header px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--ff-border-light)]">
                  {invoices.map(inv => {
                    const outstanding = inv.balance ?? (inv.totalAmount - (inv.amountPaid || 0));
                    return (
                      <tr key={inv.id} className="hover:bg-[var(--ff-bg-tertiary)] transition-colors">
                        <td className="px-4 py-3 text-sm font-medium text-[var(--ff-text-primary)]">
                          <Link href={`/accounting/supplier-invoices/${inv.id}`} className="hover:text-emerald-400 transition-colors">
                            {inv.invoiceNumber}
                          </Link>
                        </td>
                        <td className="px-4 py-3 text-sm text-[var(--ff-text-secondary)]">{inv.supplierName || '-'}</td>
                        <td className="px-4 py-3 text-sm text-[var(--ff-text-tertiary)] max-w-[240px] truncate" title={inv.reference}>
                          {inv.reference || '-'}
                        </td>
                        <td className="px-4 py-3 text-sm text-[var(--ff-text-secondary)] whitespace-nowrap">{formatDate(inv.invoiceDate)}</td>
                        <td className="px-4 py-3 text-sm text-right font-mono text-[var(--ff-text-primary)]">{formatCurrency(inv.totalAmount)}</td>
                        <td className={`px-4 py-3 text-sm text-right font-mono ${outstanding > 0 ? 'text-amber-400' : 'text-emerald-400'}`}>
                          {formatCurrency(outstanding)}
                        </td>
                        <td className="px-4 py-3"><StatusBadge status={inv.status} /></td>
                        <td className="px-4 py-3 text-right">
                          <Link href={`/accounting/supplier-invoices/${inv.id}`} className="text-emerald-600 hover:text-emerald-700">
                            <ChevronRight className="h-4 w-4" />
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
