/**
 * Account Transactions Report Page
 * Phase 3: GL account drill-down with running balance
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, BookOpen, Loader2, AlertCircle, Download } from 'lucide-react';
import { apiErrorMessage, apiFetch, apiJson, assertOk } from '@/lib/apiFetch';
import { localISODate } from '@/lib/dateUtils';
import { postedTotals } from '@/components/reports/generalLedgerRows';
import { postableAccounts } from '@/components/reports/postableAccounts';
import { formatMoney } from '@/lib/money/formatMoney';
import { formatDisplayDate } from '@/utils/dateFormat';

interface Txn {
  date: string;
  entryNumber: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
  source: string;
  /** A year-end close row: derived, not posted. */
  derived?: boolean;
}
interface Report {
  accountCode: string;
  accountName: string;
  accountType: string;
  openingBalance: number;
  closingBalance: number;
  transactions: Txn[];
}
interface GLAccount {
  id: string; accountCode: string; accountName: string;
  parentAccountId: string | null; level: number | null; hasTransactions: boolean;
}
interface CostCentre { id: string; code: string; name: string }

const fmt = (n: number) => formatMoney(n);

function getDefaultDates() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  return { periodStart: localISODate(start), periodEnd: localISODate(now) };
}

export default function AccountTransactionsPage() {
  const defaults = getDefaultDates();
  const [periodStart, setPeriodStart] = useState(defaults.periodStart);
  const [periodEnd, setPeriodEnd] = useState(defaults.periodEnd);
  const [accountCode, setAccountCode] = useState('1110');
  const [accounts, setAccounts] = useState<GLAccount[]>([]);
  const [costCentres, setCostCentres] = useState<CostCentre[]>([]);
  const [costCentreFilter, setCostCentreFilter] = useState('');
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const ccFailure = 'Could not load the cost centres - try again';
    apiFetch('/api/accounting/cost-centres', { credentials: 'include' }).then(async r => { await assertOk(r, ccFailure); return r.json(); }).then(res => {
      const list = res.data?.items || [];
      setCostCentres(list.map((c: Record<string, unknown>) => ({ id: String(c.id), code: String(c.code), name: String(c.name) })));
    }).catch(err => setError(apiErrorMessage(err, ccFailure)));
    const coaFailure = 'Could not load the chart of accounts - try again';
    apiFetch('/api/accounting/chart-of-accounts', { credentials: 'include' }).then(async r => { await assertOk(r, coaFailure); return r.json(); }).then(res => {
      const d = res.data || res;
      const list = Array.isArray(d) ? d : d.accounts || d.items || [];
      setAccounts(postableAccounts(list.map((a: Record<string, unknown>) => ({
        id: String(a.id),
        accountCode: String(a.accountCode || a.account_code || ''),
        accountName: String(a.accountName || a.account_name || ''),
        parentAccountId: (a.parentAccountId ?? a.parent_account_id ?? null) as string | null,
        level: a.level == null ? null : Number(a.level),
        hasTransactions: a.hasTransactions === true || a.has_transactions === true,
      }))));
    }).catch(err => setError(apiErrorMessage(err, coaFailure)));
  }, []);

  const requestRef = useRef(0);

  const load = useCallback(async () => {
    if (!periodStart || !periodEnd || !accountCode) {
      // Clearing an input invalidates in-flight requests and clears data and loading.
      requestRef.current += 1;
      setReport(null); setError(''); setLoading(false);
      return;
    }
    // Only the latest request may set state (same pattern as the account detail page).
    const requestId = ++requestRef.current;
    const latest = () => requestId === requestRef.current;
    const failure = 'Could not load the account transactions - try again';
    setLoading(true);
    setError('');
    setReport(null);
    try {
      const params = new URLSearchParams({
        account_code: accountCode, period_start: periodStart, period_end: periodEnd,
      });
      if (costCentreFilter) params.set('cost_centre_id', costCentreFilter);
      const result = await apiJson(`/api/accounting/reports-account-transactions?${params}`, { credentials: 'include' }, failure);
      if (latest()) setReport(result);
    } catch (err) { if (latest()) setError(apiErrorMessage(err, failure)); }
    finally { if (latest()) setLoading(false); }
  }, [periodStart, periodEnd, accountCode, costCentreFilter]);

  useEffect(() => { void load(); }, [load]);

  function handleExport() {
    const params = new URLSearchParams();
    params.set('account_code', accountCode);
    params.set('period_start', periodStart ?? '');
    params.set('period_end', periodEnd ?? '');
    if (costCentreFilter) params.set('cost_centre_id', costCentreFilter);
    window.location.href = `/api/accounting/account-transactions-export?${params}`;
  }

  // Posted rows only: a derived close row would stop the totals tying to the income statement.
  const { debit: totalDr, credit: totalCr } = postedTotals(report?.transactions ?? []);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <Link href="/accounting/reports" className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] mb-2">
            <ArrowLeft className="h-4 w-4" /> Back to Reports
          </Link>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-violet-500/10"><BookOpen className="h-6 w-6 text-violet-500" /></div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Account Transactions</h1>
            </div>
            <button onClick={handleExport} disabled={!report || !accountCode}
              className="inline-flex items-center gap-2 px-4 py-2 bg-violet-600 text-white rounded-lg hover:bg-violet-700 text-sm font-medium disabled:opacity-50">
              <Download className="h-4 w-4" /> Export CSV
            </button>
          </div>
        </div>

        <div className="p-6 max-w-5xl space-y-4">
          <div className="flex items-center gap-4 flex-wrap">
            <div>
              <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Account</label>
              <select value={accountCode} onChange={e => setAccountCode(e.target.value)} className="ff-select text-sm">
                {accounts.map(a => <option key={a.id} value={a.accountCode}>{a.accountCode} — {a.accountName}</option>)}
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
            {costCentres.length > 0 && (
              <div>
                <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Cost Centre</label>
                <select value={costCentreFilter} onChange={e => setCostCentreFilter(e.target.value)} className="ff-select text-sm">
                  <option value="">All Cost Centres</option>
                  {costCentres.map(cc => <option key={cc.id} value={cc.id}>{cc.code} — {cc.name}</option>)}
                </select>
              </div>
            )}
          </div>

          {error && <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm"><AlertCircle className="h-4 w-4" /> {error}</div>}

          {loading ? (
            <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-violet-500" /></div>
          ) : report ? (
            <>
              <div className="grid grid-cols-3 gap-4">
                <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
                  <span className="text-xs text-[var(--ff-text-tertiary)]">Account</span>
                  <p className="text-sm font-bold text-[var(--ff-text-primary)]">{report.accountCode} — {report.accountName}</p>
                  <span className="text-xs text-[var(--ff-text-tertiary)] capitalize">{report.accountType}</span>
                </div>
                <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
                  <span className="text-xs text-[var(--ff-text-tertiary)]">Opening Balance</span>
                  <p className="text-lg font-bold text-[var(--ff-text-primary)] tabular-nums">{fmt(report.openingBalance)}</p>
                </div>
                <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
                  <span className="text-xs text-[var(--ff-text-tertiary)]">Closing Balance</span>
                  <p className="text-lg font-bold text-[var(--ff-text-primary)] tabular-nums">{fmt(report.closingBalance)}</p>
                </div>
              </div>

              <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
                <table className="w-full text-sm">
                  <thead><tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
                    <th className="px-4 py-3">Date</th>
                    <th className="px-4 py-3">Entry</th>
                    <th className="px-4 py-3">Description</th>
                    <th className="px-4 py-3">Source</th>
                    <th className="px-4 py-3 text-right">Debit</th>
                    <th className="px-4 py-3 text-right">Credit</th>
                    <th className="px-4 py-3 text-right">Balance</th>
                  </tr></thead>
                  <tbody>
                    {report.transactions.length === 0 && <tr><td colSpan={7} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">No transactions</td></tr>}
                    {report.transactions.map((t, i) => (
                      <tr key={i} className={`border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50${t.derived ? ' italic' : ''}`}>
                        <td className="px-4 py-2 text-[var(--ff-text-secondary)]">{formatDisplayDate(t.date, '')}</td>
                        <td className="px-4 py-2 text-[var(--ff-text-secondary)] font-mono text-xs">{t.entryNumber}</td>
                        <td className="px-4 py-2 text-[var(--ff-text-primary)] truncate max-w-[200px]">{t.description}</td>
                        <td className="px-4 py-2"><span className="px-2 py-0.5 rounded text-xs bg-[var(--ff-bg-primary)] text-[var(--ff-text-secondary)]">{t.source}</span></td>
                        <td className="px-4 py-2 text-right tabular-nums">{t.debit > 0 ? fmt(t.debit) : ''}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{t.credit > 0 ? fmt(t.credit) : ''}</td>
                        <td className="px-4 py-2 text-right tabular-nums text-[var(--ff-text-primary)]">{fmt(t.balance)}</td>
                      </tr>
                    ))}
                    {report.transactions.length > 0 && (
                      <tr className="bg-[var(--ff-bg-primary)] font-medium">
                        <td colSpan={4} className="px-4 py-3 text-[var(--ff-text-primary)]">TOTAL</td>
                        <td className="px-4 py-3 text-right tabular-nums text-[var(--ff-text-primary)]">{fmt(totalDr)}</td>
                        <td className="px-4 py-3 text-right tabular-nums text-[var(--ff-text-primary)]">{fmt(totalCr)}</td>
                        <td className="px-4 py-3 text-right tabular-nums text-[var(--ff-text-primary)]">{fmt(report.closingBalance)}</td>
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
