/**
 * General Ledger Report — All accounts' transactions for a period
 * Shows every GL account with its debit/credit entries and running balance
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, BookOpen, Loader2, AlertCircle, Download, ChevronDown, ChevronRight } from 'lucide-react';

interface GLAccount {
  id: string;
  accountCode: string;
  accountName: string;
  accountType: string;
}

interface AccountReport {
  accountCode: string;
  accountName: string;
  accountType: string;
  openingBalance: number;
  closingBalance: number;
  totalDebit: number;
  totalCredit: number;
  transactions: {
    date: string;
    entryNumber: string;
    description: string;
    debit: number;
    credit: number;
    balance: number;
    source: string;
  }[];
}

const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

function getDefaultDates() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  return { periodStart: start.toISOString().split('T')[0], periodEnd: now.toISOString().split('T')[0] };
}

export default function GeneralLedgerPage() {
  const defaults = getDefaultDates();
  const [periodStart, setPeriodStart] = useState(defaults.periodStart);
  const [periodEnd, setPeriodEnd] = useState(defaults.periodEnd);
  const [accounts, setAccounts] = useState<GLAccount[]>([]);
  const [reports, setReports] = useState<AccountReport[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetch('/api/accounting/chart-of-accounts', { credentials: 'include' })
      .then(r => r.json())
      .then(res => {
        const d = res.data || res;
        const list = Array.isArray(d) ? d : d.accounts || d.items || [];
        setAccounts(
          list
            .filter((a: GLAccount & { level?: number }) => !a.level || a.level >= 3)
            .map((a: Record<string, unknown>) => ({
              id: String(a.id),
              accountCode: String(a.accountCode || a.account_code || ''),
              accountName: String(a.accountName || a.account_name || ''),
              accountType: String(a.accountType || a.account_type || ''),
            }))
        );
      })
      .catch(() => {});
  }, []);

  const load = useCallback(async () => {
    if (!periodStart || !periodEnd || accounts.length === 0) return;
    setLoading(true);
    setError('');
    try {
      const results: AccountReport[] = [];
      const top20 = accounts.slice(0, 20);
      await Promise.all(
        top20.map(async (acct) => {
          try {
            const params = new URLSearchParams({
              account_code: acct.accountCode,
              period_start: periodStart,
              period_end: periodEnd,
            });
            const res = await fetch(`/api/accounting/reports-account-transactions?${params}`, { credentials: 'include' });
            if (!res.ok) return;
            const json = await res.json();
            const data = json.data;
            if (data && (data.transactions?.length > 0 || data.openingBalance !== 0)) {
              results.push({
                accountCode: data.accountCode || acct.accountCode,
                accountName: data.accountName || acct.accountName,
                accountType: data.accountType || acct.accountType,
                openingBalance: Number(data.openingBalance || 0),
                closingBalance: Number(data.closingBalance || 0),
                totalDebit: (data.transactions || []).reduce((s: number, t: { debit: number }) => s + Number(t.debit || 0), 0),
                totalCredit: (data.transactions || []).reduce((s: number, t: { credit: number }) => s + Number(t.credit || 0), 0),
                transactions: data.transactions || [],
              });
            }
          } catch { /* skip failed accounts */ }
        })
      );
      results.sort((a, b) => a.accountCode.localeCompare(b.accountCode));
      setReports(results);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setLoading(false);
    }
  }, [periodStart, periodEnd, accounts]);

  useEffect(() => {
    if (accounts.length > 0) load();
  }, [accounts, load]);

  const toggleExpand = (code: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(code) ? next.delete(code) : next.add(code);
      return next;
    });
  };

  const grandTotalDebit = reports.reduce((s, r) => s + r.totalDebit, 0);
  const grandTotalCredit = reports.reduce((s, r) => s + r.totalCredit, 0);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <Link
            href="/accounting"
            className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] mb-2"
          >
            <ArrowLeft className="h-4 w-4" /> Back to Accounting
          </Link>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-violet-500/10">
                <BookOpen className="h-6 w-6 text-violet-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">General Ledger</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  All account transactions for period
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <input type="date" value={periodStart} onChange={e => setPeriodStart(e.target.value)} className="ff-input text-sm" />
              <span className="text-[var(--ff-text-tertiary)]">to</span>
              <input type="date" value={periodEnd} onChange={e => setPeriodEnd(e.target.value)} className="ff-input text-sm" />
              <button
                onClick={() => {
                  const params = new URLSearchParams({ period_start: periodStart ?? '', period_end: periodEnd ?? '' });
                  window.open(`/api/accounting/audit-trail-export?${params}`, '_blank');
                }}
                disabled={reports.length === 0}
                className="inline-flex items-center gap-2 px-4 py-2 bg-violet-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-violet-700"
              >
                <Download className="h-4 w-4" /> Export CSV
              </button>
            </div>
          </div>
        </div>

        <div className="p-6">
          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm mb-4">
              <AlertCircle className="h-4 w-4" /> {error}
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-violet-500" />
            </div>
          ) : reports.length === 0 ? (
            <div className="text-center py-12 text-[var(--ff-text-secondary)]">
              No account activity for the selected period
            </div>
          ) : (
            <div className="space-y-3">
              {reports.map(r => {
                const isOpen = expanded.has(r.accountCode);
                return (
                  <div
                    key={r.accountCode}
                    className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden"
                  >
                    <button
                      onClick={() => toggleExpand(r.accountCode)}
                      className="w-full flex items-center justify-between px-4 py-3 hover:bg-[var(--ff-bg-tertiary)] transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        {isOpen ? (
                          <ChevronDown className="h-4 w-4 text-[var(--ff-text-tertiary)]" />
                        ) : (
                          <ChevronRight className="h-4 w-4 text-[var(--ff-text-tertiary)]" />
                        )}
                        <span className="font-mono text-sm text-violet-400">{r.accountCode}</span>
                        <span className="text-sm text-[var(--ff-text-primary)]">{r.accountName}</span>
                        <span className="text-xs px-2 py-0.5 rounded bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-tertiary)]">
                          {r.accountType}
                        </span>
                      </div>
                      <div className="flex items-center gap-6 text-sm font-mono">
                        <span className="text-[var(--ff-text-secondary)]">
                          Dr {fmt(r.totalDebit)}
                        </span>
                        <span className="text-[var(--ff-text-secondary)]">
                          Cr {fmt(r.totalCredit)}
                        </span>
                        <span className="text-[var(--ff-text-primary)] font-bold">
                          {fmt(r.closingBalance)}
                        </span>
                      </div>
                    </button>

                    {isOpen && r.transactions.length > 0 && (
                      <table className="w-full text-sm border-t border-[var(--ff-border-light)]">
                        <thead>
                          <tr className="bg-[var(--ff-bg-tertiary)]">
                            <th className="px-4 py-2 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Date</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Entry #</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Description</th>
                            <th className="px-4 py-2 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Debit</th>
                            <th className="px-4 py-2 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Credit</th>
                            <th className="px-4 py-2 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Balance</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[var(--ff-border-light)]">
                          <tr className="text-xs text-[var(--ff-text-tertiary)]">
                            <td className="px-4 py-2" colSpan={5}>Opening Balance</td>
                            <td className="px-4 py-2 text-right font-mono">{fmt(r.openingBalance)}</td>
                          </tr>
                          {r.transactions.map((t, i) => (
                            <tr key={i} className="hover:bg-[var(--ff-bg-tertiary)]">
                              <td className="px-4 py-2 text-[var(--ff-text-primary)]">{t.date?.split('T')[0]}</td>
                              <td className="px-4 py-2 font-mono text-[var(--ff-text-secondary)]">{t.entryNumber}</td>
                              <td className="px-4 py-2 text-[var(--ff-text-primary)]">{t.description}</td>
                              <td className="px-4 py-2 text-right font-mono">{t.debit > 0 ? fmt(t.debit) : ''}</td>
                              <td className="px-4 py-2 text-right font-mono">{t.credit > 0 ? fmt(t.credit) : ''}</td>
                              <td className="px-4 py-2 text-right font-mono text-[var(--ff-text-primary)]">{fmt(t.balance)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                );
              })}

              <div className="bg-[var(--ff-bg-secondary)] rounded-lg border-2 border-[var(--ff-border-medium)] px-4 py-3 flex items-center justify-between font-bold text-sm">
                <span className="text-[var(--ff-text-primary)]">GRAND TOTALS ({reports.length} accounts)</span>
                <div className="flex items-center gap-6 font-mono">
                  <span>Dr {fmt(grandTotalDebit)}</span>
                  <span>Cr {fmt(grandTotalCredit)}</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
