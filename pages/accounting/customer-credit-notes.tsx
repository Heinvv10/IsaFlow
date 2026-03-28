/**
 * Customer Credit Notes Page
 * Standalone view filtered to customer credit notes only
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import {
  FileText, Plus, Loader2, AlertCircle, ChevronRight, Filter, Download,
} from 'lucide-react';
import type { CreditNote } from '@/modules/accounting/types/ar.types';
import { formatCurrency } from '@/utils/formatters';
import { apiFetch } from '@/lib/apiFetch';

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'All Statuses' },
  { value: 'draft', label: 'Draft' },
  { value: 'approved', label: 'Approved' },
  { value: 'applied', label: 'Applied' },
  { value: 'cancelled', label: 'Cancelled' },
];

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    draft: 'bg-gray-500/20 text-gray-400',
    approved: 'bg-teal-500/20 text-teal-400',
    applied: 'bg-blue-500/20 text-blue-400',
    cancelled: 'bg-red-500/20 text-red-400',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${colors[status] || 'bg-gray-500/20 text-gray-400'}`}>
      {status}
    </span>
  );
}

export default function CustomerCreditNotesPage() {
  const [creditNotes, setCreditNotes] = useState<CreditNote[]>([]);
  const [total, setTotal] = useState(0);
  const [statusFilter, setStatusFilter] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  const loadCreditNotes = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ type: 'customer' });
      if (statusFilter) params.set('status', statusFilter);
      const res = await apiFetch(`/api/accounting/credit-notes?${params}`);
      const json = await res.json();
      const payload = json.data || json;
      setCreditNotes(payload.creditNotes || []);
      setTotal(payload.total || 0);
    } catch {
      setError('Failed to load customer credit notes');
    } finally {
      setIsLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => { loadCreditNotes(); }, [loadCreditNotes]);

  const exportCSV = () => {
    const headers = ['CN #', 'Customer', 'Invoice', 'Date', 'Amount', 'Status'];
    const rows = creditNotes.map(cn => [
      cn.creditNoteNumber, cn.clientName || '',
      cn.invoiceNumber || '', new Date(cn.creditDate).toLocaleDateString('en-ZA'),
      cn.totalAmount, cn.status,
    ]);
    const csv = [headers, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `customer-credit-notes-${new Date().toISOString().split('T')[0]}.csv`; a.click();
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-500/10">
                <FileText className="h-6 w-6 text-blue-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Customer Credit Notes</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  {total} credit note{total !== 1 ? 's' : ''} recorded
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {creditNotes.length > 0 && (
                <button onClick={exportCSV} className="inline-flex items-center gap-2 px-3 py-2 border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] rounded-lg hover:bg-[var(--ff-bg-primary)] text-sm">
                  <Download className="h-4 w-4" /> CSV
                </button>
              )}
              <Link
                href="/accounting/credit-notes/new?type=customer"
                className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm font-medium"
              >
                <Plus className="h-4 w-4" /> New Credit Note
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

          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">
              <AlertCircle className="h-4 w-4" /> {error}
            </div>
          )}

          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-blue-500" />
            </div>
          ) : creditNotes.length === 0 ? (
            <div className="text-center py-12 text-[var(--ff-text-secondary)]">
              No customer credit notes found
            </div>
          ) : (
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--ff-border-light)]">
                    <th className="text-left px-4 py-3 text-[var(--ff-text-secondary)] font-medium">CN #</th>
                    <th className="text-left px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Customer</th>
                    <th className="text-left px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Invoice</th>
                    <th className="text-left px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Date</th>
                    <th className="text-right px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Amount</th>
                    <th className="text-left px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Status</th>
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {creditNotes.map(cn => (
                    <tr key={cn.id} className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)] transition-colors cursor-pointer" onClick={() => window.location.href = `/accounting/credit-notes/${cn.id}`}>
                      <td className="px-4 py-3 font-mono text-[var(--ff-text-primary)]">{cn.creditNoteNumber}</td>
                      <td className="px-4 py-3 text-[var(--ff-text-primary)]">{cn.clientName || '—'}</td>
                      <td className="px-4 py-3 text-[var(--ff-text-secondary)] font-mono text-xs">
                        {cn.invoiceNumber || '—'}
                      </td>
                      <td className="px-4 py-3 text-[var(--ff-text-secondary)]">
                        {new Date(cn.creditDate).toLocaleDateString('en-ZA')}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-[var(--ff-text-primary)]">
                        {formatCurrency(cn.totalAmount)}
                      </td>
                      <td className="px-4 py-3"><StatusBadge status={cn.status} /></td>
                      <td className="px-4 py-3 text-right">
                        <ChevronRight className="h-4 w-4 text-[var(--ff-text-tertiary)]" />
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
