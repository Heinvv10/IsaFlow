/**
 * Year-End Processing
 * Sage equivalent: Accountant's Area > Year-End
 * Close financial year, create closing journals, carry forward retained earnings
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { CalendarCheck, Loader2, AlertCircle, CheckCircle2, Lock } from 'lucide-react';
import { ExportCSVButton } from '@/components/shared/ExportCSVButton';

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(amount);
}

interface FiscalYear {
  year_label: string;
  start_date: string;
  end_date: string;
  status: string;
  periods_open: number;
  periods_closed: number;
  total_revenue: number;
  total_expenses: number;
  net_income: number;
}

export default function YearEndPage() {
  const [fiscalYears, setFiscalYears] = useState<FiscalYear[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isProcessing, setIsProcessing] = useState(false);
  const [message, setMessage] = useState({ type: '', text: '' });

  const loadYears = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/accounting/year-end');
      const json = await res.json();
      const data = json.data || json;
      setFiscalYears(data.years || []);
    } catch {
      setMessage({ type: 'error', text: 'Failed to load fiscal years' });
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { loadYears(); }, [loadYears]);

  const processYearEnd = async (yearLabel: string) => {
    setIsProcessing(true);
    setMessage({ type: '', text: '' });
    try {
      const res = await fetch('/api/accounting/year-end', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ yearLabel, action: 'close' }),
      });
      const json = await res.json();
      if (res.ok) {
        setMessage({ type: 'success', text: `Year ${yearLabel} closed. Closing journal created.` });
        loadYears();
      } else {
        setMessage({ type: 'error', text: json.message || 'Year-end processing failed' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Year-end request failed' });
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4">
            <div className="flex items-center justify-between w-full">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-orange-500/10">
                  <CalendarCheck className="h-6 w-6 text-orange-500" />
                </div>
                <div>
                  <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Year-End Processing</h1>
                  <p className="text-sm text-[var(--ff-text-secondary)]">
                    Close fiscal years and create closing journal entries
                  </p>
                </div>
              </div>
              <ExportCSVButton endpoint="/api/accounting/year-end-export" filenamePrefix="year-end" label="Export CSV" />
            </div>
          </div>
        </div>

        <div className="p-6 max-w-4xl">
          {/* Warning banner */}
          <div className="flex items-start gap-3 p-4 rounded-lg bg-amber-500/10 border border-amber-500/20 mb-6">
            <AlertCircle className="h-5 w-5 text-amber-400 mt-0.5" />
            <div className="text-sm">
              <p className="font-medium text-amber-400">Year-end processing is irreversible</p>
              <p className="text-[var(--ff-text-secondary)] mt-1">
                This will close all periods in the fiscal year, create a closing journal entry
                that zeros revenue and expense accounts, and carry the net income to Retained Earnings.
                Ensure all transactions are posted before proceeding.
              </p>
            </div>
          </div>

          {message.text && (
            <div className={`flex items-center gap-2 p-3 rounded-lg text-sm mb-6 ${
              message.type === 'error' ? 'bg-red-500/10 text-red-400' : 'bg-emerald-500/10 text-emerald-400'
            }`}>
              {message.type === 'success' ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
              {message.text}
            </div>
          )}

          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-orange-500" />
            </div>
          ) : fiscalYears.length === 0 ? (
            <div className="text-center py-12">
              <CalendarCheck className="h-12 w-12 text-[var(--ff-text-tertiary)] mx-auto mb-3" />
              <p className="text-[var(--ff-text-secondary)]">No fiscal years found</p>
              <p className="text-sm text-[var(--ff-text-tertiary)] mt-1">
                Create fiscal periods first in Accounts &gt; Fiscal Periods
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {fiscalYears.map((fy) => (
                <div key={fy.year_label} className="p-6 rounded-xl bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)]">
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <h3 className="text-lg font-semibold text-[var(--ff-text-primary)]">
                        Fiscal Year {fy.year_label}
                      </h3>
                      <p className="text-sm text-[var(--ff-text-secondary)]">
                        {fy.start_date?.split('T')[0]} to {fy.end_date?.split('T')[0]}
                      </p>
                    </div>
                    <span className={`px-3 py-1 rounded-full text-xs font-medium ${
                      fy.status === 'closed' ? 'bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-tertiary)]' :
                      fy.periods_open === 0 ? 'bg-amber-500/10 text-amber-400' :
                      'bg-emerald-500/10 text-emerald-400'
                    }`}>
                      {fy.status === 'closed' ? 'Closed' : `${fy.periods_open} periods open`}
                    </span>
                  </div>

                  <div className="grid grid-cols-3 gap-4 mb-4">
                    <div className="p-3 rounded-lg bg-[var(--ff-bg-tertiary)]">
                      <p className="text-xs text-[var(--ff-text-tertiary)]">Total Revenue</p>
                      <p className="text-lg font-bold text-emerald-400">{formatCurrency(fy.total_revenue)}</p>
                    </div>
                    <div className="p-3 rounded-lg bg-[var(--ff-bg-tertiary)]">
                      <p className="text-xs text-[var(--ff-text-tertiary)]">Total Expenses</p>
                      <p className="text-lg font-bold text-red-400">{formatCurrency(fy.total_expenses)}</p>
                    </div>
                    <div className="p-3 rounded-lg bg-[var(--ff-bg-tertiary)]">
                      <p className="text-xs text-[var(--ff-text-tertiary)]">Net Income</p>
                      <p className={`text-lg font-bold ${fy.net_income >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {formatCurrency(fy.net_income)}
                      </p>
                    </div>
                  </div>

                  {fy.status !== 'closed' && (
                    <button
                      onClick={() => processYearEnd(fy.year_label)}
                      disabled={isProcessing || fy.periods_open > 0}
                      className="px-4 py-2 bg-orange-600 hover:bg-orange-700 disabled:opacity-50 text-white rounded-lg flex items-center gap-2 text-sm"
                    >
                      {isProcessing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />}
                      {fy.periods_open > 0 ? 'Close all periods first' : 'Process Year-End'}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
