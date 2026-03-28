/**
 * Bank Transactions Report Page
 * Phase 3: Reporting Parity
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, Landmark, Loader2, AlertCircle, Download } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface Txn {
  date: string;
  entryNumber: string;
  description: string;
  deposit: number;
  withdrawal: number;
  runningBalance: number;
}
interface Report {
  accountCode: string;
  accountName: string;
  openingBalance: number;
  closingBalance: number;
  transactions: Txn[];
}

const fmt = (n: number) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

function getDefaultDates() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  return { periodStart: start.toISOString().split('T')[0], periodEnd: now.toISOString().split('T')[0] };
}

export default function BankTransactionsPage() {
  const defaults = getDefaultDates();
  const [periodStart, setPeriodStart] = useState(defaults.periodStart);
  const [periodEnd, setPeriodEnd] = useState(defaults.periodEnd);
  const [accountCode, setAccountCode] = useState('1110');
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!periodStart || !periodEnd) return;
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({
        period_start: periodStart, period_end: periodEnd, account_code: accountCode,
      });
      const res = await apiFetch(`/api/accounting/reports-bank-transactions?${params}`, { credentials: 'include' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed');
      setReport(json.data || null);
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed'); }
    finally { setLoading(false); }
  }, [periodStart, periodEnd, accountCode]);

  useEffect(() => { load(); }, [load]);

  function handleExport() {
    const params = new URLSearchParams();
    params.set('period_start', periodStart ?? '');
    params.set('period_end', periodEnd ?? '');
    params.set('account_code', accountCode);
    window.location.href = `/api/accounting/bank-transactions-export?${params}`;
  }

  const totalDep = report?.transactions.reduce((s, t) => s + t.deposit, 0) || 0;
  const totalWd = report?.transactions.reduce((s, t) => s + t.withdrawal, 0) || 0;

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <Link href="/accounting/reports" className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] mb-2">
            <ArrowLeft className="h-4 w-4" /> Back to Reports
          </Link>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-cyan-500/10"><Landmark className="h-6 w-6 text-cyan-500" /></div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Bank Transactions</h1>
            </div>
            <button onClick={handleExport} disabled={!report || report.transactions.length === 0}
              className="inline-flex items-center gap-2 px-4 py-2 bg-cyan-600 text-white rounded-lg hover:bg-cyan-700 text-sm font-medium disabled:opacity-50">
              <Download className="h-4 w-4" /> Export CSV
            </button>
          </div>
        </div>

        <div className="p-6 max-w-5xl space-y-4">
          <div className="flex items-center gap-4">
            <div>
              <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Bank Account</label>
              <select value={accountCode} onChange={e => setAccountCode(e.target.value)} className="ff-select text-sm">
                <option value="1110">1110 — Bank Primary</option>
                <option value="1130">1130 — Petty Cash</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">From</label>
              <input type="date" value={periodStart} onChange={e => setPeriodStart(e.target.value)} className="ff-input text-sm" />
            </div>
            <div>
              <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">To</label>
              <input type="date" value={periodEnd} onChange={e => setPeriodEnd(e.target.value)} className="ff-input text-sm" />
            </div>
          </div>

          {error && <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm"><AlertCircle className="h-4 w-4" /> {error}</div>}

          {loading ? (
            <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-cyan-500" /></div>
          ) : report ? (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
                  <span className="text-xs text-[var(--ff-text-tertiary)]">Opening Balance</span>
                  <p className="text-lg font-bold text-[var(--ff-text-primary)] font-mono">{fmt(report.openingBalance)}</p>
                </div>
                <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
                  <span className="text-xs text-[var(--ff-text-tertiary)]">Closing Balance</span>
                  <p className="text-lg font-bold text-[var(--ff-text-primary)] font-mono">{fmt(report.closingBalance)}</p>
                </div>
              </div>

              <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
                <table className="w-full text-sm">
                  <thead><tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
                    <th className="px-4 py-3">Date</th>
                    <th className="px-4 py-3">Entry</th>
                    <th className="px-4 py-3">Description</th>
                    <th className="px-4 py-3 text-right">Deposit</th>
                    <th className="px-4 py-3 text-right">Withdrawal</th>
                    <th className="px-4 py-3 text-right">Balance</th>
                  </tr></thead>
                  <tbody>
                    {report.transactions.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">No transactions</td></tr>}
                    {report.transactions.map((t, i) => (
                      <tr key={i} className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50">
                        <td className="px-4 py-2 text-[var(--ff-text-secondary)]">{t.date}</td>
                        <td className="px-4 py-2 text-[var(--ff-text-secondary)] font-mono text-xs">{t.entryNumber}</td>
                        <td className="px-4 py-2 text-[var(--ff-text-primary)] truncate max-w-[250px]">{t.description}</td>
                        <td className="px-4 py-2 text-right font-mono text-teal-400">{t.deposit > 0 ? fmt(t.deposit) : ''}</td>
                        <td className="px-4 py-2 text-right font-mono text-red-400">{t.withdrawal > 0 ? fmt(t.withdrawal) : ''}</td>
                        <td className="px-4 py-2 text-right font-mono text-[var(--ff-text-primary)]">{fmt(t.runningBalance)}</td>
                      </tr>
                    ))}
                    {report.transactions.length > 0 && (
                      <tr className="bg-[var(--ff-bg-primary)] font-medium">
                        <td colSpan={3} className="px-4 py-3 text-[var(--ff-text-primary)]">TOTAL</td>
                        <td className="px-4 py-3 text-right font-mono text-teal-400">{fmt(totalDep)}</td>
                        <td className="px-4 py-3 text-right font-mono text-red-400">{fmt(totalWd)}</td>
                        <td className="px-4 py-3 text-right font-mono text-[var(--ff-text-primary)]">{fmt(report.closingBalance)}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </AppLayout>
  );
}
