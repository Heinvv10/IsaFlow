/**
 * VAT201 Return Report Page
 * Full SARS VAT201 form with expandable transaction drill-down
 * Sage equivalent: Accountant's Area > VAT > VAT Return
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import {
  Receipt,
  Loader2,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
} from 'lucide-react';

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(amount);
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' });
}

interface VAT201Transaction {
  journalEntryId: string;
  entryNumber: string;
  entryDate: string;
  description: string;
  sourceDocument?: string;
  amount: number;
}

interface VAT201Box {
  box: string;
  label: string;
  amount: number;
  transactions?: VAT201Transaction[];
}

interface VAT201Report {
  periodStart: string;
  periodEnd: string;
  outputBoxes: VAT201Box[];
  totalOutputTax: number;
  inputBoxes: VAT201Box[];
  totalInputTax: number;
  netVAT: number;
}

function getDefaultDates() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const end = new Date(now.getFullYear(), now.getMonth(), 0);
  return {
    periodStart: start.toISOString().split('T')[0],
    periodEnd: end.toISOString().split('T')[0],
  };
}

function BoxRow({ box, section }: { box: VAT201Box; section: 'output' | 'input' }) {
  const [expanded, setExpanded] = useState(false);
  const hasTransactions = box.transactions && box.transactions.length > 0;
  const isPositive = box.amount > 0;
  const colorClass = section === 'output'
    ? (isPositive ? 'text-red-400' : 'text-[var(--ff-text-tertiary)]')
    : (isPositive ? 'text-emerald-400' : 'text-[var(--ff-text-tertiary)]');

  return (
    <div>
      <button
        onClick={() => hasTransactions && setExpanded(!expanded)}
        className={`w-full flex items-center justify-between px-4 py-2.5 text-sm border-b border-[var(--ff-border-light)] transition-colors ${
          hasTransactions ? 'hover:bg-[var(--ff-bg-tertiary)] cursor-pointer' : 'cursor-default'
        } ${expanded ? 'bg-[var(--ff-bg-tertiary)]' : ''}`}
      >
        <div className="flex items-center gap-2">
          {hasTransactions ? (
            expanded ? <ChevronDown className="h-3.5 w-3.5 text-[var(--ff-text-tertiary)]" /> : <ChevronRight className="h-3.5 w-3.5 text-[var(--ff-text-tertiary)]" />
          ) : (
            <span className="w-3.5" />
          )}
          <span className="font-mono text-xs text-[var(--ff-text-tertiary)] w-12">{box.box}</span>
          <span className="text-[var(--ff-text-secondary)]">{box.label}</span>
          {hasTransactions && (
            <span className="text-xs text-[var(--ff-text-tertiary)] bg-[var(--ff-bg-tertiary)] px-1.5 py-0.5 rounded">
              {box.transactions!.length}
            </span>
          )}
        </div>
        <span className={`font-mono font-medium ${Math.abs(box.amount) < 0.01 ? 'text-[var(--ff-text-tertiary)]' : colorClass}`}>
          {formatCurrency(box.amount)}
        </span>
      </button>

      {expanded && hasTransactions && (
        <div className="bg-[var(--ff-bg-primary)] border-b border-[var(--ff-border-light)]">
          <div className="px-4 py-1.5 flex items-center gap-4 text-xs text-[var(--ff-text-tertiary)] border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)]/50">
            <span className="w-24">Date</span>
            <span className="w-28">Entry #</span>
            <span className="flex-1">Description</span>
            <span className="w-28 text-right">Amount</span>
          </div>
          {box.transactions!.map((tx, i) => (
            <div
              key={`${tx.journalEntryId}-${i}`}
              className="px-4 py-1.5 flex items-center gap-4 text-xs border-b border-[var(--ff-border-light)]/50 hover:bg-[var(--ff-bg-tertiary)]/30"
            >
              <span className="w-24 text-[var(--ff-text-tertiary)]">{formatDate(tx.entryDate)}</span>
              <span className="w-28 font-mono text-[var(--ff-text-secondary)]">{tx.entryNumber}</span>
              <span className="flex-1 text-[var(--ff-text-secondary)] truncate">{tx.description}</span>
              <span className={`w-28 text-right font-mono ${tx.amount >= 0 ? colorClass : 'text-[var(--ff-text-tertiary)]'}`}>
                {formatCurrency(tx.amount)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function VATReturnPage() {
  const defaults = getDefaultDates();
  const [periodStart, setPeriodStart] = useState(defaults.periodStart);
  const [periodEnd, setPeriodEnd] = useState(defaults.periodEnd);
  const [report, setReport] = useState<VAT201Report | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const loadReport = useCallback(async () => {
    if (!periodStart || !periodEnd) return;
    setIsLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ period_start: periodStart, period_end: periodEnd });
      const res = await fetch(`/api/accounting/reports-vat-return?${params}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed to load');
      setReport(json.data || json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load VAT return');
    } finally {
      setIsLoading(false);
    }
  }, [periodStart, periodEnd]);

  useEffect(() => { loadReport(); }, [loadReport]);

  const outputWithActivity = report?.outputBoxes.filter(b => Math.abs(b.amount) > 0.01) || [];
  const inputWithActivity = report?.inputBoxes.filter(b => Math.abs(b.amount) > 0.01) || [];

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-amber-500/10">
                  <Receipt className="h-6 w-6 text-amber-500" />
                </div>
                <div>
                  <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">VAT201 Return</h1>
                  <p className="text-sm text-[var(--ff-text-secondary)]">
                    SARS Value-Added Tax Declaration
                  </p>
                </div>
              </div>
              <button onClick={() => {
                const params = new URLSearchParams({ period_start: periodStart ?? '', period_end: periodEnd ?? '' });
                window.open(`/api/accounting/vat-return-export?${params}`, '_blank');
              }} disabled={!report}
                className="px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white rounded-lg flex items-center gap-2 text-sm font-medium disabled:opacity-50">
                <Download className="h-4 w-4" /> Export CSV
              </button>
            </div>
          </div>
        </div>

        <div className="p-6 max-w-5xl space-y-6">
          {/* Date filters */}
          <div className="flex items-center gap-4">
            <div>
              <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Period Start</label>
              <input
                type="date"
                value={periodStart}
                onChange={e => setPeriodStart(e.target.value)}
                className="px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Period End</label>
              <input
                type="date"
                value={periodEnd}
                onChange={e => setPeriodEnd(e.target.value)}
                className="px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm"
              />
            </div>
          </div>

          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">
              <AlertCircle className="h-4 w-4" /> {error}
            </div>
          )}

          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-amber-500" />
            </div>
          ) : report ? (
            <div className="space-y-6">
              {/* Summary Cards */}
              <div className="grid grid-cols-3 gap-4">
                <div className="p-4 rounded-xl bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)]">
                  <p className="text-xs text-[var(--ff-text-tertiary)] mb-1">Total Output Tax (Box 13)</p>
                  <p className="text-2xl font-bold text-red-400 font-mono">{formatCurrency(report.totalOutputTax)}</p>
                </div>
                <div className="p-4 rounded-xl bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)]">
                  <p className="text-xs text-[var(--ff-text-tertiary)] mb-1">Total Input Tax (Box 19)</p>
                  <p className="text-2xl font-bold text-emerald-400 font-mono">{formatCurrency(report.totalInputTax)}</p>
                </div>
                <div className={`p-4 rounded-xl border ${
                  report.netVAT > 0
                    ? 'bg-red-500/5 border-red-500/30'
                    : 'bg-emerald-500/5 border-emerald-500/30'
                }`}>
                  <p className="text-xs text-[var(--ff-text-tertiary)] mb-1">
                    Net VAT — Box 20 {report.netVAT > 0 ? '(Payable to SARS)' : '(Refundable)'}
                  </p>
                  <p className={`text-2xl font-bold font-mono ${report.netVAT > 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                    {formatCurrency(Math.abs(report.netVAT))}
                  </p>
                </div>
              </div>

              {/* SECTION A — Output Tax */}
              <div className="rounded-xl bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] overflow-hidden">
                <div className="px-4 py-3 bg-red-500/5 border-b border-[var(--ff-border-light)] flex items-center gap-2">
                  <FileText className="h-4 w-4 text-red-400" />
                  <h2 className="font-semibold text-[var(--ff-text-primary)]">Section A — Output Tax</h2>
                  <span className="text-xs text-[var(--ff-text-tertiary)] ml-auto">Click rows to expand transactions</span>
                </div>
                {report.outputBoxes.map(box => (
                  <BoxRow key={box.box} box={box} section="output" />
                ))}
                <div className="px-4 py-3 flex justify-between items-center bg-red-500/10 border-t border-[var(--ff-border-light)]">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-[var(--ff-text-tertiary)] w-12">13</span>
                    <span className="font-semibold text-[var(--ff-text-primary)]">TOTAL OUTPUT TAX</span>
                  </div>
                  <span className="font-mono font-bold text-red-400 text-lg">{formatCurrency(report.totalOutputTax)}</span>
                </div>
              </div>

              {/* SECTION B — Input Tax */}
              <div className="rounded-xl bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] overflow-hidden">
                <div className="px-4 py-3 bg-emerald-500/5 border-b border-[var(--ff-border-light)] flex items-center gap-2">
                  <FileText className="h-4 w-4 text-emerald-400" />
                  <h2 className="font-semibold text-[var(--ff-text-primary)]">Section B — Input Tax</h2>
                  <span className="text-xs text-[var(--ff-text-tertiary)] ml-auto">Click rows to expand transactions</span>
                </div>
                {report.inputBoxes.map(box => (
                  <BoxRow key={box.box} box={box} section="input" />
                ))}
                <div className="px-4 py-3 flex justify-between items-center bg-emerald-500/10 border-t border-[var(--ff-border-light)]">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-[var(--ff-text-tertiary)] w-12">19</span>
                    <span className="font-semibold text-[var(--ff-text-primary)]">TOTAL INPUT TAX</span>
                  </div>
                  <span className="font-mono font-bold text-emerald-400 text-lg">{formatCurrency(report.totalInputTax)}</span>
                </div>
              </div>

              {/* NET VAT */}
              <div className={`rounded-xl border-2 p-5 ${
                report.netVAT > 0
                  ? 'border-red-500/40 bg-red-500/5'
                  : 'border-emerald-500/40 bg-emerald-500/5'
              }`}>
                <div className="flex justify-between items-center">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm text-[var(--ff-text-tertiary)]">Box 20</span>
                      <span className="text-lg font-bold text-[var(--ff-text-primary)]">
                        VAT {report.netVAT > 0 ? 'PAYABLE' : 'REFUNDABLE'}
                      </span>
                    </div>
                    <p className="text-sm text-[var(--ff-text-tertiary)] mt-1">
                      Box 13 ({formatCurrency(report.totalOutputTax)}) minus Box 19 ({formatCurrency(report.totalInputTax)})
                    </p>
                  </div>
                  <span className={`text-3xl font-bold font-mono ${
                    report.netVAT > 0 ? 'text-red-400' : 'text-emerald-400'
                  }`}>
                    {formatCurrency(Math.abs(report.netVAT))}
                  </span>
                </div>
              </div>

              {/* Activity breakdown */}
              {(outputWithActivity.length > 0 || inputWithActivity.length > 0) && (
                <div className="text-xs text-[var(--ff-text-tertiary)] px-1">
                  Active boxes: {outputWithActivity.map(b => `${b.box}`).join(', ')}
                  {outputWithActivity.length > 0 && inputWithActivity.length > 0 && ' | '}
                  {inputWithActivity.map(b => `${b.box}`).join(', ')}
                </div>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </AppLayout>
  );
}
