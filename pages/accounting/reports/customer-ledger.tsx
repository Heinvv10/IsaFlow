/**
 * Customer Transaction Ledger Page
 * Shows all invoices + receipts for a selected customer with running balance.
 */

import { useState, useCallback } from 'react';
import { FixDateNotice, GatedDateField, useDateGate } from '@/components/forms/GatedDateField';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, BookOpen, Loader2, AlertCircle, Download } from 'lucide-react';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { localISODate } from '@/lib/dateUtils';
import { CustomerLedgerResults, typeLabel, type LedgerData } from '@/components/reports/CustomerLedgerResults';

interface Customer {
  id: string;
  name: string;
}

function getDefaultDates() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const dateFrom = localISODate(start);
  const dateTo = localISODate(now);
  return { dateFrom, dateTo };
}

function exportCsv(data: LedgerData, dateFrom: string, dateTo: string) {
  const lines: string[] = [
    `Customer Transaction Ledger — ${data.customer_name}`,
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
  a.download = `customer-ledger-${data.customer_name.replace(/\s+/g, '-')}-${dateFrom}-${dateTo}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function CustomerLedgerPage() {
  const defaults = getDefaultDates();

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customersLoaded, setCustomersLoaded] = useState(false);
  const [customerId, setCustomerId] = useState('');
  const [dateFrom, setDateFrom] = useState(defaults.dateFrom);
  const [dateTo, setDateTo] = useState(defaults.dateTo);
  const dates = useDateGate();
  const [ledger, setLedger] = useState<LedgerData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const loadCustomers = useCallback(async () => {
    if (customersLoaded) return;
    try {
      const res = await apiFetch('/api/accounting/customers', { credentials: 'include' });
      await assertOk(res, 'Could not load customers - try again');
      const json = await res.json();
      setCustomers((json.data as Customer[]) || []);
      setCustomersLoaded(true);
    } catch (err) {
      setCustomers([]); setError(apiErrorMessage(err, 'Could not load customers - try again'));
    }
  }, [customersLoaded]);

  const runReport = useCallback(async () => {
    if (!customerId) {
      setError('Please select a customer');
      return;
    }
    setLoading(true);
    setError('');
    setLedger(null);
    try {
      const params = new URLSearchParams({ customerId });
      if (dateFrom) params.set('dateFrom', dateFrom);
      if (dateTo) params.set('dateTo', dateTo);
      const res = await apiFetch(`/api/accounting/reports-customer-ledger?${params}`, {
        credentials: 'include',
      });
      await assertOk(res, 'Could not load the ledger - try again');
      const json = await res.json();
      setLedger((json as { data: LedgerData }).data);
    } catch (err) {
      setLedger(null); setError(apiErrorMessage(err, 'Could not load the ledger - try again'));
    } finally {
      setLoading(false);
    }
  }, [customerId, dateFrom, dateTo]);

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
              <div className="p-2 rounded-lg bg-blue-500/10">
                <BookOpen className="h-6 w-6 text-blue-600 dark:text-blue-400" />
              </div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">
                Customer Transaction Ledger
              </h1>
            </div>
            <button
              onClick={() => ledger && exportCsv(ledger, dateFrom, dateTo)}
              disabled={!ledger || ledger.transactions.length === 0 || dates.blocked}
              className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium disabled:opacity-50"
            >
              <Download className="h-4 w-4" /> Export CSV
            </button>
          </div>
        </div>

        <div className="p-6 max-w-5xl space-y-4">
          {/* Filters */}
          <div className="flex flex-wrap items-end gap-4">
            <div className="flex-1 min-w-[200px]">
              <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Customer</label>
              <select
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
                onFocus={loadCustomers}
                className="ff-input text-sm w-full"
              >
                <option value="">-- Select customer --</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <GatedDateField gate={dates} gateKey="from" label="From" value={dateFrom || null} onValue={setDateFrom} />
            </div>
            <div>
              <GatedDateField gate={dates} gateKey="to" label="To" value={dateTo || null} onValue={setDateTo} />
            </div>
            <button
              onClick={runReport}
              disabled={loading || !customerId || dates.blocked}
              className="inline-flex items-center gap-2 px-5 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium disabled:opacity-50"
            >
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              Run Report
            </button>
          </div>

          <FixDateNotice gate={dates} />
          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">
              <AlertCircle className="h-4 w-4" /> {error}
            </div>
          )}

          {loading && (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-blue-600 dark:text-blue-400" />
            </div>
          )}

          {/* Results */}
          {!loading && ledger && <CustomerLedgerResults ledger={ledger} />}
        </div>
      </div>
    </AppLayout>
  );
}
