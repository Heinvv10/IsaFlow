/**
 * Customer Statement Page
 * Route: /accounting/customers/statement
 *
 * Date-range customer statement with PDF download.
 * Sage equivalent: Customers > Statements > Generate Statement
 */

import { useState, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import {
  ArrowLeft,
  FileText,
  Download,
  Loader2,
  AlertCircle,
  Search,
  ClipboardList,
  ExternalLink,
} from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { formatCurrency } from '@/utils/formatters';
import { useRouter } from 'next/router';

interface Customer { id: string; name: string; email?: string | null; phone?: string | null; }

interface StatementTransaction {
  id: string;
  date: string;
  type: 'invoice' | 'payment' | 'credit_note';
  reference: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
}

interface StatementSummary {
  totalInvoiced: number;
  totalPaid: number;
  totalCredits: number;
  balance: number;
}

interface StatementResult {
  customer: Customer;
  fromDate: string;
  toDate: string;
  transactions: StatementTransaction[];
  summary: StatementSummary;
}

const TYPE_LABELS: Record<string, string> = {
  invoice: 'Invoice',
  payment: 'Payment',
  credit_note: 'Credit Note',
};

const TYPE_COLORS: Record<string, string> = {
  invoice: 'bg-blue-500/10 text-blue-400',
  payment: 'bg-teal-500/10 text-teal-400',
  credit_note: 'bg-amber-500/10 text-amber-400',
};

function formatDate(d: string): string {
  const parts = d.split('T')[0]?.split('-') ?? [];
  return parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : d;
}

export default function CustomerStatementPage() {
  const router = useRouter();

  // Form state
  const today = new Date().toISOString().split('T')[0] as string;
  const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string;

  const [fromDate, setFromDate] = useState(oneYearAgo);
  const [toDate, setToDate] = useState(today);
  const [customerSearch, setCustomerSearch] = useState('');
  const [customerResults, setCustomerResults] = useState<Customer[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [searching, setSearching] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [statement, setStatement] = useState<StatementResult | null>(null);
  const [downloadingPdf, setDownloadingPdf] = useState(false);

  // Customer search with debounce
  const searchCustomers = useCallback(async (q: string) => {
    if (!q.trim() || q.length < 2) { setCustomerResults([]); return; }
    setSearching(true);
    try {
      const res = await apiFetch(`/api/accounting/customers?q=${encodeURIComponent(q)}`, { credentials: 'include' });
      const json = await res.json();
      setCustomerResults((json.data || []).slice(0, 10));
    } catch { setCustomerResults([]); }
    finally { setSearching(false); }
  }, []);

  const handleSearchChange = (val: string) => {
    setCustomerSearch(val);
    if (selectedCustomer) { setSelectedCustomer(null); setStatement(null); }
    searchCustomers(val);
  };

  const selectCustomer = (c: Customer) => {
    setSelectedCustomer(c);
    setCustomerSearch(c.name);
    setCustomerResults([]);
    setStatement(null);
  };

  const handlePreview = async () => {
    if (!selectedCustomer) { setError('Please select a customer'); return; }
    setLoading(true);
    setError('');
    setStatement(null);
    try {
      const params = new URLSearchParams({
        customerId: selectedCustomer.id,
        fromDate,
        toDate,
      });
      const res = await apiFetch(`/api/accounting/customer-statement?${params}`, { credentials: 'include' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message || 'Failed to load statement');
      setStatement(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load statement');
    } finally {
      setLoading(false);
    }
  };

  const handleDownloadPdf = async () => {
    if (!statement) return;
    setDownloadingPdf(true);
    try {
      // Import the same statementPdf utility used on the detail page
      const { generateStatementPdf } = await import('@/modules/accounting/utils/statementPdf');
      let companyName = '';
      let companyVatNumber = '';
      try {
        const settingsRes = await apiFetch('/api/accounting/accounting-settings', { credentials: 'include' });
        const settingsJson = await settingsRes.json();
        const settings = Array.isArray(settingsJson.data) ? settingsJson.data : [];
        companyName = settings.find((s: { key: string }) => s.key === 'company_name')?.value || '';
        companyVatNumber = settings.find((s: { key: string }) => s.key === 'company_vat_number')?.value || '';
      } catch { /* use empty defaults */ }

      const blob = await generateStatementPdf({
        clientName: statement.customer.name,
        clientEmail: statement.customer.email ?? undefined,
        clientPhone: statement.customer.phone ?? undefined,
        asAtDate: toDate,
        totalInvoiced: statement.summary.totalInvoiced,
        totalPaid: statement.summary.totalPaid,
        totalCredits: statement.summary.totalCredits,
        balanceOutstanding: statement.summary.balance,
        transactions: statement.transactions,
        companyName,
        companyVatNumber,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `statement-${statement.customer.name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}-${fromDate}-to-${toDate}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate PDF');
    } finally {
      setDownloadingPdf(false);
    }
  };

  const handlePrintHtml = () => {
    if (!selectedCustomer) return;
    const params = new URLSearchParams({
      customerId: selectedCustomer.id,
      fromDate,
      toDate,
      format: 'pdf',
    });
    window.open(`/api/accounting/customer-statement?${params}`, '_blank');
  };

  function getTxnUrl(txn: StatementTransaction): string | null {
    if (txn.type === 'invoice') return `/accounting/customer-invoices/${txn.id}`;
    if (txn.type === 'payment') return `/accounting/customer-payments/${txn.id}`;
    return null;
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <Link href="/accounting/customer-statements"
            className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-purple-400 mb-3">
            <ArrowLeft className="h-4 w-4" /> Back to Customer Statements
          </Link>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-purple-500/10">
              <ClipboardList className="h-6 w-6 text-purple-500" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Generate Statement</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">
                Customer statement with running balance for a date range
              </p>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-6 max-w-5xl">
          {/* Filter Bar */}
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5">
            <h2 className="text-sm font-semibold text-[var(--ff-text-primary)] mb-4">Statement Parameters</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* Customer Picker */}
              <div className="md:col-span-1 relative">
                <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Customer *</label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--ff-text-tertiary)]" />
                  <input
                    type="text"
                    name="search"
                    placeholder="Type to search..."
                    value={customerSearch}
                    onChange={e => handleSearchChange(e.target.value)}
                    className="ff-input w-full pl-9"
                  />
                  {searching && (
                    <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-[var(--ff-text-tertiary)]" />
                  )}
                </div>
                {customerResults.length > 0 && (
                  <div className="absolute top-full left-0 right-0 z-10 mt-1 bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg shadow-lg max-h-48 overflow-y-auto">
                    {customerResults.map(c => (
                      <button key={c.id} onClick={() => selectCustomer(c)}
                        className="w-full text-left px-4 py-2.5 text-sm hover:bg-[var(--ff-bg-primary)] text-[var(--ff-text-primary)]">
                        {c.name}
                        {c.email && <span className="ml-2 text-xs text-[var(--ff-text-tertiary)]">{c.email}</span>}
                      </button>
                    ))}
                  </div>
                )}
                {selectedCustomer && (
                  <p className="text-xs text-teal-400 mt-1">Selected: {selectedCustomer.name}</p>
                )}
              </div>

              {/* Date Range */}
              <div>
                <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">From Date</label>
                <input type="date" name="dateFrom" value={fromDate} onChange={e => setFromDate(e.target.value)}
                  className="ff-input w-full" />
              </div>
              <div>
                <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">To Date</label>
                <input type="date" name="dateTo" value={toDate} onChange={e => setToDate(e.target.value)}
                  className="ff-input w-full" />
              </div>
            </div>

            {/* Quick date presets */}
            <div className="flex items-center gap-2 mt-3 flex-wrap">
              <span className="text-xs text-[var(--ff-text-tertiary)]">Quick:</span>
              {[
                { label: 'This Month', from: today.substring(0, 7) + '-01', to: today },
                { label: 'Last 3 Months', from: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string, to: today },
                { label: 'Last 6 Months', from: new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string, to: today },
                { label: 'Last 12 Months', from: oneYearAgo, to: today },
              ].map(preset => (
                <button key={preset.label}
                  onClick={() => { setFromDate(preset.from); setToDate(preset.to); setStatement(null); }}
                  className="px-2 py-1 text-xs rounded bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]">
                  {preset.label}
                </button>
              ))}
            </div>

            {/* Action Buttons */}
            <div className="flex items-center gap-3 mt-4 pt-4 border-t border-[var(--ff-border-light)]">
              <button onClick={handlePreview} disabled={loading || !selectedCustomer}
                className="inline-flex items-center gap-2 px-5 py-2.5 bg-purple-600 text-white rounded-lg hover:bg-purple-700 text-sm font-medium disabled:opacity-50">
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
                {loading ? 'Loading...' : 'Preview Statement'}
              </button>

              {statement && (
                <>
                  <button onClick={handleDownloadPdf} disabled={downloadingPdf}
                    className="inline-flex items-center gap-2 px-4 py-2.5 bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] rounded-lg text-sm disabled:opacity-50">
                    {downloadingPdf ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                    {downloadingPdf ? 'Generating...' : 'Download PDF'}
                  </button>
                  <button onClick={handlePrintHtml}
                    className="inline-flex items-center gap-2 px-4 py-2.5 bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] rounded-lg text-sm">
                    <ExternalLink className="h-4 w-4" />
                    Print / Save PDF
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Error */}
          {error && (
            <div className="flex items-center gap-2 p-4 rounded-lg bg-red-500/10 text-red-400 text-sm">
              <AlertCircle className="h-4 w-4 flex-shrink-0" />{error}
            </div>
          )}

          {/* Statement Preview */}
          {statement && (
            <div className="space-y-4">
              {/* Customer + Period */}
              <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5">
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="text-lg font-bold text-[var(--ff-text-primary)]">{statement.customer.name}</h3>
                    {statement.customer.email && (
                      <p className="text-sm text-[var(--ff-text-secondary)]">{statement.customer.email}</p>
                    )}
                    {statement.customer.phone && (
                      <p className="text-sm text-[var(--ff-text-secondary)]">{statement.customer.phone}</p>
                    )}
                  </div>
                  <div className="text-right text-sm text-[var(--ff-text-secondary)]">
                    <p>Period: {formatDate(statement.fromDate)} — {formatDate(statement.toDate)}</p>
                    <p>{statement.transactions.length} transaction{statement.transactions.length !== 1 ? 's' : ''}</p>
                  </div>
                </div>
              </div>

              {/* Summary Cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {[
                  { label: 'Total Invoiced', value: statement.summary.totalInvoiced, color: 'blue' },
                  { label: 'Total Paid', value: statement.summary.totalPaid, color: 'teal' },
                  { label: 'Credits Applied', value: statement.summary.totalCredits, color: 'amber' },
                  {
                    label: 'Balance Outstanding',
                    value: statement.summary.balance,
                    color: statement.summary.balance > 0 ? 'red' : 'teal',
                  },
                ].map(card => (
                  <div key={card.label} className="p-4 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
                    <p className="text-xs text-[var(--ff-text-tertiary)] mb-1">{card.label}</p>
                    <p className={`text-xl font-bold text-${card.color}-400`}>{formatCurrency(card.value)}</p>
                  </div>
                ))}
              </div>

              {/* Transactions Table */}
              {statement.transactions.length === 0 ? (
                <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-8 text-center">
                  <ClipboardList className="h-10 w-10 text-[var(--ff-text-tertiary)] mx-auto mb-2" />
                  <p className="text-[var(--ff-text-secondary)]">No transactions in this date range</p>
                </div>
              ) : (
                <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
                  <div className="px-5 py-3 border-b border-[var(--ff-border-light)]">
                    <h3 className="text-sm font-semibold text-[var(--ff-text-primary)]">Transactions</h3>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)]/50">
                          <th className="text-left px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Date</th>
                          <th className="text-left px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Type</th>
                          <th className="text-left px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Reference</th>
                          <th className="text-left px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Description</th>
                          <th className="text-right px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Debit</th>
                          <th className="text-right px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Credit</th>
                          <th className="text-right px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Balance</th>
                          <th className="w-8" />
                        </tr>
                      </thead>
                      <tbody>
                        {statement.transactions.map((txn, i) => {
                          const url = getTxnUrl(txn);
                          return (
                            <tr key={`${txn.type}-${txn.id}-${i}`}
                              onClick={url ? () => router.push(url) : undefined}
                              className={`border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50 ${url ? 'cursor-pointer' : ''}`}>
                              <td className="px-4 py-3 text-[var(--ff-text-secondary)] whitespace-nowrap">
                                {formatDate(txn.date)}
                              </td>
                              <td className="px-4 py-3">
                                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${TYPE_COLORS[txn.type] || ''}`}>
                                  {TYPE_LABELS[txn.type] || txn.type}
                                </span>
                              </td>
                              <td className="px-4 py-3 font-mono text-[var(--ff-text-primary)]">{txn.reference}</td>
                              <td className="px-4 py-3 text-[var(--ff-text-tertiary)] max-w-[200px] truncate">
                                {txn.description || '—'}
                              </td>
                              <td className="px-4 py-3 text-right font-mono text-[var(--ff-text-primary)]">
                                {txn.debit > 0 ? formatCurrency(txn.debit) : ''}
                              </td>
                              <td className={`px-4 py-3 text-right font-mono ${txn.type === 'payment' ? 'text-teal-400' : 'text-amber-400'}`}>
                                {txn.credit > 0 ? formatCurrency(txn.credit) : ''}
                              </td>
                              <td className={`px-4 py-3 text-right font-mono font-medium ${txn.balance > 0 ? 'text-[var(--ff-text-primary)]' : 'text-teal-400'}`}>
                                {formatCurrency(txn.balance)}
                              </td>
                              <td className="px-2 py-3">
                                {url && <ExternalLink className="h-3.5 w-3.5 text-[var(--ff-text-tertiary)]" />}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                      <tfoot>
                        <tr className="border-t-2 border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)]/50">
                          <td colSpan={4} className="px-4 py-3 text-sm font-semibold text-[var(--ff-text-secondary)]">
                            Closing Balance
                          </td>
                          <td className="px-4 py-3 text-right font-mono font-bold text-[var(--ff-text-primary)]">
                            {formatCurrency(statement.summary.totalInvoiced)}
                          </td>
                          <td className="px-4 py-3 text-right font-mono font-bold text-teal-400">
                            {formatCurrency(statement.summary.totalPaid + statement.summary.totalCredits)}
                          </td>
                          <td className={`px-4 py-3 text-right font-mono font-bold text-lg ${statement.summary.balance > 0 ? 'text-red-400' : 'text-teal-400'}`}>
                            {formatCurrency(statement.summary.balance)}
                          </td>
                          <td />
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
