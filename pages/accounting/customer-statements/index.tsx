/**
 * Customer Statements
 * Sage equivalent: Customers > Reports > Statements
 * Generate and email customer account statements
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ClipboardList, Loader2, AlertCircle, Download, ChevronRight, Search } from 'lucide-react';
import { formatCurrency } from '@/utils/formatters';
import { apiFetch } from '@/lib/apiFetch';

interface CustomerBalance {
  client_id: string;
  client_name: string;
  total_invoiced: number;
  total_paid: number;
  balance: number;
  last_payment_date?: string;
  invoice_count: number;
}

/** Triggers a CSV download in the browser using a temporary anchor element. */
function triggerCsvDownload(csvContent: string, filename: string): void {
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

/** Builds CSV content from a list of CustomerBalance rows. */
function buildCsv(rows: CustomerBalance[]): string {
  const header = 'Customer,Total Invoiced,Total Paid,Balance,# Invoices,Last Payment';
  const lines = rows.map((c) =>
    [
      `"${c.client_name.replace(/"/g, '""')}"`,
      c.total_invoiced.toFixed(2),
      c.total_paid.toFixed(2),
      c.balance.toFixed(2),
      c.invoice_count,
      c.last_payment_date?.split('T')[0] ?? '',
    ].join(',')
  );
  return [header, ...lines].join('\n');
}

export default function CustomerStatementsPage() {
  const [customers, setCustomers] = useState<CustomerBalance[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [asAtDate, setAsAtDate] = useState(new Date().toISOString().split('T')[0]);
  const [search, setSearch] = useState('');

  const filteredCustomers = useMemo(() => {
    if (!search.trim()) return customers;
    const q = search.toLowerCase();
    return customers.filter(c => c.client_name.toLowerCase().includes(q));
  }, [customers, search]);

  /** Downloads all loaded customer balances as a single CSV file. */
  function handleDownloadAll(): void {
    if (customers.length === 0) return;
    const csv = buildCsv(customers);
    triggerCsvDownload(csv, `statements-all-${asAtDate}.csv`);
  }

  const loadStatements = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const res = await apiFetch(`/api/accounting/customer-statements?as_at_date=${asAtDate}`);
      const json = await res.json();
      const data = json.data || json;
      setCustomers(data.customers || []);
    } catch {
      setError('Failed to load customer statements');
    } finally {
      setIsLoading(false);
    }
  }, [asAtDate]);

  useEffect(() => { loadStatements(); }, [loadStatements]);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-purple-500/10">
                <ClipboardList className="h-6 w-6 text-purple-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Customer Statements</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  Account balances and statement generation
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="p-6">
          <div className="flex items-center gap-4 mb-6 flex-wrap">
            <label htmlFor="asAtDate" className="text-sm text-[var(--ff-text-secondary)]">As at:</label>
            <input
              id="asAtDate"
              type="date"
              value={asAtDate}
              onChange={(e) => setAsAtDate(e.target.value)}
              className="px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm"
              aria-label="Statement date"
            />
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--ff-text-tertiary)]" />
              <input
                type="text"
                placeholder="Search customer..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="pl-9 pr-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm placeholder:text-[var(--ff-text-tertiary)] w-48"
              />
            </div>
            {customers.length > 0 && (
              <button
                onClick={handleDownloadAll}
                className="ml-auto flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 text-sm font-medium transition-colors"
                title="Download all customer balances as CSV"
              >
                <Download className="h-4 w-4" />
                Download All
              </button>
            )}
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-purple-500" />
            </div>
          ) : error ? (
            <div className="flex items-center gap-2 text-red-400 py-8 justify-center">
              <AlertCircle className="h-5 w-5" />
              <span>{error}</span>
            </div>
          ) : filteredCustomers.length === 0 ? (
            <div className="text-center py-12">
              <ClipboardList className="h-12 w-12 text-[var(--ff-text-tertiary)] mx-auto mb-3" />
              <p className="text-[var(--ff-text-secondary)]">No customer balances found</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--ff-border-light)]">
                    <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Customer</th>
                    <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Invoiced</th>
                    <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Paid</th>
                    <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Balance</th>
                    <th className="text-center py-3 px-4 text-[var(--ff-text-secondary)] font-medium"># Invoices</th>
                    <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Last Payment</th>
                    <th className="text-center py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredCustomers.map((c) => (
                    <tr key={c.client_id} className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-tertiary)]">
                      <td className="py-3 px-4 text-[var(--ff-text-primary)] font-medium">
                        <Link href={`/accounting/customer-statements/${c.client_id}`} className="hover:text-purple-400 transition-colors">
                          {c.client_name}
                        </Link>
                      </td>
                      <td className="py-3 px-4 text-right text-[var(--ff-text-primary)]">{formatCurrency(c.total_invoiced)}</td>
                      <td className="py-3 px-4 text-right text-teal-400">{formatCurrency(c.total_paid)}</td>
                      <td className="py-3 px-4 text-right font-medium text-[var(--ff-text-primary)]">{formatCurrency(c.balance)}</td>
                      <td className="py-3 px-4 text-center text-[var(--ff-text-secondary)]">{c.invoice_count}</td>
                      <td className="py-3 px-4 text-[var(--ff-text-secondary)]">{c.last_payment_date?.split('T')[0] || '-'}</td>
                      <td className="py-3 px-4 text-center">
                        <Link href={`/accounting/customer-statements/${c.client_id}`}
                          className="inline-flex items-center gap-1 px-4 py-3 rounded-lg text-purple-400 hover:bg-purple-500/10 hover:text-purple-300 text-sm font-medium transition-colors"
                          title={`View ${c.client_name} statement`}>
                          View <ChevronRight className="h-4 w-4" />
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
