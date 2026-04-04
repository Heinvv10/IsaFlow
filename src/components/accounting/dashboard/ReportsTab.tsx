/**
 * Reports Tab — report navigation cards and inline trial balance viewer
 */

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Loader2, BarChart3, AlertCircle } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import type { FiscalPeriod, TrialBalanceRow } from '@/modules/accounting/types/gl.types';

const REPORT_LINKS = [
  { href: '/accounting/reports/income-statement', label: 'Income Statement', sub: 'Profit & Loss', hoverColor: 'hover:border-teal-500/50' },
  { href: '/accounting/reports/balance-sheet', label: 'Balance Sheet', sub: 'Assets = L + E', hoverColor: 'hover:border-blue-500/50' },
  { href: '/accounting/reports/vat-return', label: 'VAT Return', sub: 'Input / Output VAT', hoverColor: 'hover:border-amber-500/50' },
  { href: '/accounting/reports/project-profitability', label: 'Project Profitability', sub: 'Revenue vs costs', hoverColor: 'hover:border-purple-500/50' },
];

function fmtCurrency(amount: number): string {
  if (amount === 0) return '-';
  return 'R ' + Number(amount).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function ReportsTab() {
  const [periods, setPeriods] = useState<FiscalPeriod[]>([]);
  const [selectedPeriod, setSelectedPeriod] = useState<string>('');
  const [trialBalance, setTrialBalance] = useState<TrialBalanceRow[]>([]);
  const [totals, setTotals] = useState({ debit: 0, credit: 0 });
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => { loadPeriods(); }, []);

  const loadPeriods = async () => {
    try {
      const res = await apiFetch('/api/accounting/fiscal-periods');
      const data = await res.json();
      const list: FiscalPeriod[] = data.data || data || [];
      setPeriods(list);
      const current = list.find(p => p.status === 'open');
      if (current) setSelectedPeriod(current.id);
    } catch (err) {
      log.error('Failed to load periods for reports', { error: err }, 'accounting-ui');
    }
  };

  const loadTrialBalance = async (periodId: string) => {
    setIsLoading(true);
    try {
      const res = await apiFetch(`/api/accounting/reports-trial-balance?fiscal_period_id=${periodId}`);
      const data = await res.json();
      const payload = data.data || data;
      setTrialBalance(payload.rows || []);
      setTotals({ debit: payload.totalDebit || 0, credit: payload.totalCredit || 0 });
    } catch (err) {
      log.error('Failed to load trial balance', { error: err }, 'accounting-ui');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (selectedPeriod) loadTrialBalance(selectedPeriod);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPeriod]);

  return (
    <div className="space-y-6">
      {/* Report Navigation */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {REPORT_LINKS.map(r => (
          <Link key={r.href} href={r.href} className={`p-4 rounded-lg bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] ${r.hoverColor} transition-all no-underline`}>
            <p className="font-medium text-sm text-[var(--ff-text-primary)]">{r.label}</p>
            <p className="text-xs text-[var(--ff-text-tertiary)]">{r.sub}</p>
          </Link>
        ))}
      </div>

      {/* Period Selector */}
      <div className="flex items-center gap-4">
        <label className="text-sm font-medium text-[var(--ff-text-primary)]">Fiscal Period:</label>
        <select
          value={selectedPeriod}
          onChange={e => setSelectedPeriod(e.target.value)}
          className="ff-select text-sm py-2 px-3 min-w-[200px]"
        >
          <option value="">Select period...</option>
          {periods.map(p => (
            <option key={p.id} value={p.id}>{p.periodName} ({p.fiscalYear})</option>
          ))}
        </select>
      </div>

      {/* Trial Balance */}
      <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
        <div className="px-6 py-4 border-b border-[var(--ff-border-light)]">
          <h3 className="text-lg font-semibold text-[var(--ff-text-primary)]">Trial Balance</h3>
        </div>

        {!selectedPeriod ? (
          <div className="p-8 text-center">
            <BarChart3 className="h-8 w-8 text-[var(--ff-text-tertiary)] mx-auto mb-2" />
            <p className="text-[var(--ff-text-secondary)]">Select a fiscal period to view the trial balance</p>
          </div>
        ) : isLoading ? (
          <div className="p-8 text-center">
            <Loader2 className="h-6 w-6 animate-spin text-[var(--ff-text-tertiary)] mx-auto" />
          </div>
        ) : trialBalance.length === 0 ? (
          <div className="p-8 text-center">
            <BarChart3 className="h-8 w-8 text-[var(--ff-text-tertiary)] mx-auto mb-2" />
            <p className="text-[var(--ff-text-secondary)]">No balances found for this period</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-[var(--ff-bg-tertiary)] border-b border-[var(--ff-border-light)]">
                  {['Code', 'Account', 'Type', 'Debit', 'Credit'].map((h, i) => (
                    <th key={h} className={`px-6 py-3 text-xs font-semibold uppercase tracking-wider text-[var(--ff-text-secondary)] ${i >= 3 ? 'text-right' : 'text-left'}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {trialBalance.map(row => (
                  <tr key={row.accountCode} className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-tertiary)] transition-colors">
                    <td className="px-6 py-3 text-sm font-mono text-[var(--ff-text-primary)]">{row.accountCode}</td>
                    <td className="px-6 py-3 text-sm text-[var(--ff-text-primary)]">{row.accountName}</td>
                    <td className="px-6 py-3 text-sm text-[var(--ff-text-secondary)] capitalize">{row.accountType}</td>
                    <td className="px-6 py-3 text-sm text-right font-medium text-[var(--ff-text-primary)]">{fmtCurrency(row.debitBalance)}</td>
                    <td className="px-6 py-3 text-sm text-right font-medium text-[var(--ff-text-primary)]">{fmtCurrency(row.creditBalance)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-[var(--ff-bg-tertiary)] border-t-2 border-[var(--ff-border-medium)]">
                  <td colSpan={3} className="px-6 py-3 text-sm font-semibold text-[var(--ff-text-primary)]">Total</td>
                  <td className="px-6 py-3 text-sm text-right font-bold text-[var(--ff-text-primary)]">{fmtCurrency(totals.debit)}</td>
                  <td className="px-6 py-3 text-sm text-right font-bold text-[var(--ff-text-primary)]">{fmtCurrency(totals.credit)}</td>
                </tr>
                {totals.debit !== totals.credit && (
                  <tr className="bg-red-500/10">
                    <td colSpan={3} className="px-6 py-2 text-xs font-medium text-red-400 flex items-center gap-1">
                      <AlertCircle className="h-3 w-3" /> Out of balance
                    </td>
                    <td colSpan={2} className="px-6 py-2 text-xs text-right text-red-400">
                      Difference: {fmtCurrency(Math.abs(totals.debit - totals.credit))}
                    </td>
                  </tr>
                )}
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
