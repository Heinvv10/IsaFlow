/**
 * Cash Movement Report
 * Shows inflows, outflows and net movement per bank account for a date range.
 */

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { formatCurrency } from '@/utils/formatters';
import { ArrowDownCircle, ArrowUpCircle, Banknote, Loader2, AlertCircle, TrendingUp } from 'lucide-react';

interface CashMovementRow {
  account_id: string;
  account_name: string;
  account_number: string | null;
  opening_balance: number;
  inflows: number;
  outflows: number;
  net_movement: number;
  closing_balance: number;
}

interface CashMovementTotals {
  opening_balance: number;
  inflows: number;
  outflows: number;
  net_movement: number;
  closing_balance: number;
}

interface CashMovementData {
  from: string;
  to: string;
  accounts: CashMovementRow[];
  totals: CashMovementTotals;
}

function defaultFrom(): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().substring(0, 10);
}

function defaultTo(): string {
  return new Date().toISOString().substring(0, 10);
}

export default function CashMovementPage() {
  const [data, setData] = useState<CashMovementData | null>(null);
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ from, to });
      const res = await apiFetch(`/api/accounting/reports/cash-movement?${params}`);
      const json = await res.json();
      if (!res.ok) {
        setError(json?.error?.message ?? 'Failed to load cash movement report');
        return;
      }
      setData(json.data ?? json);
    } catch {
      setError('Failed to load cash movement report');
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => { void loadData(); }, [loadData]);

  const netColor = (n: number) =>
    n >= 0 ? 'text-teal-400' : 'text-red-400';

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10">
                <TrendingUp className="h-6 w-6 text-teal-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Cash Movement</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  Inflows, outflows and net movement per bank account
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="p-6 max-w-5xl space-y-6">
          {/* Date range picker */}
          <div className="flex items-end gap-4">
            <div>
              <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">From</label>
              <input
                type="date"
                value={from}
                onChange={e => setFrom(e.target.value)}
                className="px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">To</label>
              <input
                type="date"
                value={to}
                onChange={e => setTo(e.target.value)}
                className="px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm"
              />
            </div>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
            </div>
          ) : error ? (
            <div className="flex items-center gap-2 text-red-400 py-10 justify-center">
              <AlertCircle className="h-5 w-5" />
              <span>{error}</span>
            </div>
          ) : !data || data.accounts.length === 0 ? (
            <div className="text-center py-16">
              <Banknote className="h-12 w-12 text-[var(--ff-text-tertiary)] mx-auto mb-3" />
              <p className="text-[var(--ff-text-secondary)]">No bank accounts found for this period</p>
            </div>
          ) : (
            <>
              {/* Summary cards */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="rounded-xl bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] p-4 flex items-center gap-4">
                  <div className="p-2 rounded-lg bg-teal-500/10">
                    <ArrowDownCircle className="h-6 w-6 text-teal-400" />
                  </div>
                  <div>
                    <p className="text-xs text-[var(--ff-text-tertiary)] mb-0.5">Total Inflows</p>
                    <p className="text-lg font-bold text-teal-400 font-mono">
                      {formatCurrency(data.totals.inflows)}
                    </p>
                  </div>
                </div>

                <div className="rounded-xl bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] p-4 flex items-center gap-4">
                  <div className="p-2 rounded-lg bg-red-500/10">
                    <ArrowUpCircle className="h-6 w-6 text-red-400" />
                  </div>
                  <div>
                    <p className="text-xs text-[var(--ff-text-tertiary)] mb-0.5">Total Outflows</p>
                    <p className="text-lg font-bold text-red-400 font-mono">
                      {formatCurrency(data.totals.outflows)}
                    </p>
                  </div>
                </div>

                <div className="rounded-xl bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] p-4 flex items-center gap-4">
                  <div className={`p-2 rounded-lg ${data.totals.net_movement >= 0 ? 'bg-teal-500/10' : 'bg-red-500/10'}`}>
                    <TrendingUp className={`h-6 w-6 ${netColor(data.totals.net_movement)}`} />
                  </div>
                  <div>
                    <p className="text-xs text-[var(--ff-text-tertiary)] mb-0.5">Net Movement</p>
                    <p className={`text-lg font-bold font-mono ${netColor(data.totals.net_movement)}`}>
                      {formatCurrency(data.totals.net_movement)}
                    </p>
                  </div>
                </div>
              </div>

              {/* Per-account table */}
              <div className="rounded-xl bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)]">
                        <th className="px-4 py-3 text-left font-semibold text-[var(--ff-text-secondary)]">
                          Account
                        </th>
                        <th className="px-4 py-3 text-right font-semibold text-[var(--ff-text-secondary)]">
                          Opening
                        </th>
                        <th className="px-4 py-3 text-right font-semibold text-teal-400">
                          Inflows
                        </th>
                        <th className="px-4 py-3 text-right font-semibold text-red-400">
                          Outflows
                        </th>
                        <th className="px-4 py-3 text-right font-semibold text-[var(--ff-text-secondary)]">
                          Net Movement
                        </th>
                        <th className="px-4 py-3 text-right font-semibold text-[var(--ff-text-secondary)]">
                          Closing
                        </th>
                        <th className="px-4 py-3 text-center font-semibold text-[var(--ff-text-secondary)]">
                          Detail
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--ff-border-light)]">
                      {data.accounts.map(acc => (
                        <tr key={acc.account_id} className="hover:bg-[var(--ff-bg-tertiary)] transition-colors">
                          <td className="px-4 py-3">
                            <p className="font-medium text-[var(--ff-text-primary)]">{acc.account_name}</p>
                            {acc.account_number && (
                              <p className="text-xs text-[var(--ff-text-tertiary)]">{acc.account_number}</p>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-[var(--ff-text-secondary)]">
                            {formatCurrency(acc.opening_balance)}
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-teal-400">
                            {formatCurrency(acc.inflows)}
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-red-400">
                            {formatCurrency(acc.outflows)}
                          </td>
                          <td className={`px-4 py-3 text-right font-mono font-semibold ${netColor(acc.net_movement)}`}>
                            {formatCurrency(acc.net_movement)}
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-[var(--ff-text-primary)] font-semibold">
                            {formatCurrency(acc.closing_balance)}
                          </td>
                          <td className="px-4 py-3 text-center">
                            <Link
                              href={`/accounting/reports/bank-transactions?account=${acc.account_id}&from=${data.from}&to=${data.to}`}
                              className="text-xs text-teal-400 hover:text-teal-300 underline underline-offset-2 whitespace-nowrap"
                            >
                              Drill down
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    {/* Totals footer */}
                    <tfoot>
                      <tr className="border-t-2 border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)]">
                        <td className="px-4 py-3 font-semibold text-[var(--ff-text-primary)]">Totals</td>
                        <td className="px-4 py-3 text-right font-mono font-semibold text-[var(--ff-text-primary)]">
                          {formatCurrency(data.totals.opening_balance)}
                        </td>
                        <td className="px-4 py-3 text-right font-mono font-bold text-teal-400">
                          {formatCurrency(data.totals.inflows)}
                        </td>
                        <td className="px-4 py-3 text-right font-mono font-bold text-red-400">
                          {formatCurrency(data.totals.outflows)}
                        </td>
                        <td className={`px-4 py-3 text-right font-mono font-bold ${netColor(data.totals.net_movement)}`}>
                          {formatCurrency(data.totals.net_movement)}
                        </td>
                        <td className="px-4 py-3 text-right font-mono font-bold text-[var(--ff-text-primary)]">
                          {formatCurrency(data.totals.closing_balance)}
                        </td>
                        <td />
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
