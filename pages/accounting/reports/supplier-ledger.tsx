/**
 * Supplier Transaction Ledger Page
 * Shows all invoices + payments for a selected supplier with running balance.
 */

import { useState, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, BookOpen, Loader2, AlertCircle, Download } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface Supplier {
  id: string;
  name: string;
}

interface LedgerRow {
  type: string;
  transaction_id: string;
  reference: string | null;
  transaction_date: string;
  debit: number;
  credit: number;
  status: string;
  running_balance: number;
}

interface LedgerData {
  supplier_name: string;
  opening_balance: number;
  closing_balance: number;
  transactions: LedgerRow[];
}

const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

function getDefaultDates() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const dateFrom = start.toISOString().split('T')[0] ?? start.toISOString().slice(0, 10);
  const dateTo = now.toISOString().split('T')[0] ?? now.toISOString().slice(0, 10);
  return { dateFrom, dateTo };
}

function typeLabel(type: string): string {
  if (type === 'invoice') return 'Invoice';
  if (type === 'payment') return 'Payment';
  return type.charAt(0).toUpperCase() + type.slice(1);
}

function exportCsv(data: LedgerData, dateFrom: string, dateTo: string) {
  const lines: string[] = [
    `Supplier Transaction Ledger — ${data.supplier_name}`,
    `Period: ${dateFrom} to ${dateTo}`,
    '',
    'Date,Type,Reference,Debit (ZAR),Credit (ZAR),Balance (ZAR),Status',
    ...data.transactions.map((r) =>
      [
        r.transaction_date,
        typeLabel(r.type),
        r.reference ?? '',
        r.debit.toFixed(2),
        r.credit.toFixed(2),
        r.running_balance.toFixed(2),
        r.status,
      ].join(',')
    ),
    '',
    `Opening Balance,,,,,${data.opening_balance.toFixed(2)},`,
    `Closing Balance,,,,,${data.closing_balance.toFixed(2)},`,
  ];

  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `supplier-ledger-${data.supplier_name.replace(/\s+/g, '-')}-${dateFrom}-${dateTo}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function SupplierLedgerPage() {
  const defaults = getDefaultDates();

  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [suppliersLoaded, setSuppliersLoaded] = useState(false);
  const [supplierId, setSupplierId] = useState('');
  const [dateFrom, setDateFrom] = useState(defaults.dateFrom);
  const [dateTo, setDateTo] = useState(defaults.dateTo);
  const [ledger, setLedger] = useState<LedgerData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const loadSuppliers = useCallback(async () => {
    if (suppliersLoaded) return;
    try {
      const res = await apiFetch('/api/accounting/suppliers-list', { credentials: 'include' });
      const json = await res.json();
      if (res.ok) {
        const d = json.data ?? json;
        setSuppliers((Array.isArray(d) ? d : (d.suppliers ?? [])) as Supplier[]);
        setSuppliersLoaded(true);
      }
    } catch {
      // non-fatal
    }
  }, [suppliersLoaded]);

  const runReport = useCallback(async () => {
    if (!supplierId) {
      setError('Please select a supplier');
      return;
    }
    setLoading(true);
    setError('');
    setLedger(null);
    try {
      const params = new URLSearchParams({ supplierId });
      if (dateFrom) params.set('dateFrom', dateFrom);
      if (dateTo) params.set('dateTo', dateTo);
      const res = await apiFetch(`/api/accounting/reports-supplier-ledger?${params}`, {
        credentials: 'include',
      });
      const json = await res.json();
      if (!res.ok) throw new Error((json as { message?: string }).message ?? 'Failed');
      setLedger((json as { data: LedgerData }).data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load ledger');
    } finally {
      setLoading(false);
    }
  }, [supplierId, dateFrom, dateTo]);

  const totalDebits = ledger
    ? ledger.transactions.reduce((sum, r) => sum + r.debit, 0)
    : 0;
  const totalCredits = ledger
    ? ledger.transactions.reduce((sum, r) => sum + r.credit, 0)
    : 0;

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <Link
            href="/accounting/reports"
            className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] mb-2"
          >
            <ArrowLeft className="h-4 w-4" /> Back to Reports
          </Link>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-orange-500/10">
                <BookOpen className="h-6 w-6 text-orange-500" />
              </div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">
                Supplier Transaction Ledger
              </h1>
            </div>
            <button
              onClick={() => ledger && exportCsv(ledger, dateFrom, dateTo)}
              disabled={!ledger || ledger.transactions.length === 0}
              className="inline-flex items-center gap-2 px-4 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 text-sm font-medium disabled:opacity-50"
            >
              <Download className="h-4 w-4" /> Export CSV
            </button>
          </div>
        </div>

        <div className="p-6 max-w-5xl space-y-4">
          {/* Filters */}
          <div className="flex flex-wrap items-end gap-4">
            <div className="flex-1 min-w-[200px]">
              <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Supplier</label>
              <select
                value={supplierId}
                onChange={(e) => setSupplierId(e.target.value)}
                onFocus={loadSuppliers}
                className="ff-input text-sm w-full"
              >
                <option value="">-- Select supplier --</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">From</label>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="ff-input text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">To</label>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="ff-input text-sm"
              />
            </div>
            <button
              onClick={runReport}
              disabled={loading || !supplierId}
              className="inline-flex items-center gap-2 px-5 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 text-sm font-medium disabled:opacity-50"
            >
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              Run Report
            </button>
          </div>

          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">
              <AlertCircle className="h-4 w-4" /> {error}
            </div>
          )}

          {loading && (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-orange-500" />
            </div>
          )}

          {/* Results */}
          {!loading && ledger && (
            <>
              {ledger.supplier_name && (
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  Ledger for{' '}
                  <span className="font-semibold text-[var(--ff-text-primary)]">
                    {ledger.supplier_name}
                  </span>
                </p>
              )}

              <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
                      <th className="px-4 py-3">Date</th>
                      <th className="px-4 py-3">Type</th>
                      <th className="px-4 py-3">Reference</th>
                      <th className="px-4 py-3 text-right">Debit</th>
                      <th className="px-4 py-3 text-right">Credit</th>
                      <th className="px-4 py-3 text-right">Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ledger.transactions.length === 0 && (
                      <tr>
                        <td
                          colSpan={6}
                          className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]"
                        >
                          No transactions for the selected period
                        </td>
                      </tr>
                    )}
                    {ledger.transactions.map((row) => (
                      <tr
                        key={row.transaction_id}
                        className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50"
                      >
                        <td className="px-4 py-2 text-[var(--ff-text-secondary)] font-mono text-xs">
                          {row.transaction_date}
                        </td>
                        <td className="px-4 py-2">
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                              row.type === 'invoice'
                                ? 'bg-orange-500/10 text-orange-400'
                                : 'bg-teal-500/10 text-teal-400'
                            }`}
                          >
                            {typeLabel(row.type)}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-[var(--ff-text-primary)]">
                          {row.reference ?? '—'}
                        </td>
                        <td className="px-4 py-2 text-right font-mono">
                          {row.debit > 0 ? (
                            <span className="text-red-400">{fmt(row.debit)}</span>
                          ) : (
                            <span className="text-[var(--ff-text-tertiary)]">—</span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-right font-mono">
                          {row.credit > 0 ? (
                            <span className="text-teal-400">{fmt(row.credit)}</span>
                          ) : (
                            <span className="text-[var(--ff-text-tertiary)]">—</span>
                          )}
                        </td>
                        <td
                          className="px-4 py-2 text-right font-mono font-medium"
                          style={{
                            color:
                              row.running_balance > 0.005
                                ? 'var(--ff-text-primary)'
                                : 'rgb(52 211 153)',
                          }}
                        >
                          {fmt(row.running_balance)}
                        </td>
                      </tr>
                    ))}

                    {/* Footer totals */}
                    {ledger.transactions.length > 0 && (
                      <tr className="bg-[var(--ff-bg-primary)] font-medium border-t-2 border-[var(--ff-border-light)]">
                        <td
                          colSpan={3}
                          className="px-4 py-3 text-[var(--ff-text-secondary)] text-xs uppercase tracking-wide"
                        >
                          Totals
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-red-400">
                          {fmt(totalDebits)}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-teal-400">
                          {fmt(totalCredits)}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-[var(--ff-text-primary)]">
                          {fmt(ledger.closing_balance)}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* Summary strip */}
              {ledger.transactions.length > 0 && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {[
                    {
                      label: 'Opening Balance',
                      value: ledger.opening_balance,
                      color: 'text-[var(--ff-text-primary)]',
                    },
                    { label: 'Total Debits', value: totalDebits, color: 'text-red-400' },
                    { label: 'Total Credits', value: totalCredits, color: 'text-teal-400' },
                    {
                      label: 'Closing Balance',
                      value: ledger.closing_balance,
                      color:
                        ledger.closing_balance > 0.005
                          ? 'text-[var(--ff-text-primary)]'
                          : 'text-teal-400',
                    },
                  ].map(({ label, value, color }) => (
                    <div
                      key={label}
                      className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] px-4 py-3"
                    >
                      <p className="text-xs text-[var(--ff-text-tertiary)] mb-1">{label}</p>
                      <p className={`font-mono font-semibold text-base ${color}`}>{fmt(value)}</p>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
