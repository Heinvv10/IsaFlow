/**
 * Account Transactions Report Page
 * Phase 3: GL account drill-down with running balance
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, BookOpen, Loader2, AlertCircle, Download } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface Txn {
  date: string;
  entryNumber: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
  source: string;
}
interface Report {
  accountCode: string;
  accountName: string;
  accountType: string;
  openingBalance: number;
  closingBalance: number;
  transactions: Txn[];
}
interface GLAccount { id: string; accountCode: string; accountName: string }
interface CostCentre { id: string; code: string; name: string }

const fmt = (n: number) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

function getDefaultDates() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  return { periodStart: start.toISOString().split('T')[0], periodEnd: now.toISOString().split('T')[0] };
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
    apiFetch('/api/accounting/cost-centres', { credentials: 'include' }).then(r => r.json()).then(res => {
      const list = res.data?.items || [];
      setCostCentres(list.map((c: Record<string, unknown>) => ({ id: String(c.id), code: String(c.code), name: String(c.name) })));
    }).catch(() => { /* reference data load failure — non-critical, cost centre filter will be empty */ });
    apiFetch('/api/accounting/chart-of-accounts', { credentials: 'include' }).then(r => r.json()).then(res => {
      const d = res.data || res;
      const list = Array.isArray(d) ? d : d.accounts || d.items || [];
      setAccounts(list.filter((a: GLAccount & { level?: number }) => (a as { level?: number }).level === undefined || (a as { level?: number }).level! >= 3).map((a: Record<string, unknown>) => ({
        id: String(a.id),
        accountCode: String(a.accountCode || a.account_code || ''),
        accountName: String(a.accountName || a.account_name || ''),
      })));
    });
  }, []);

  const load = useCallback(async () => {
    if (!periodStart || !periodEnd || !accountCode) return;
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({
        account_code: accountCode, period_start: periodStart, period_end: periodEnd,
      });
      if (costCentreFilter) params.set('cost_centre', costCentreFilter);
      const res = await apiFetch(`/api/accounting/reports-account-transactions?${params}`, { credentials: 'include' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed');
      setReport(json.data || null);
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed'); }
    finally { setLoading(false); }
  }, [periodStart, periodEnd, accountCode, costCentreFilter]);

  useEffect(() => { load(); }, [load]);

  function handleExport() {
    const params = new URLSearchParams();
    params.set('account_code', accountCode);
    params.set('period_start', periodStart ?? '');
    params.set('period_end', periodEnd ?? '');
    window.location.href = `/api/accounting/account-transactions-export?${params}`;
  }

  const totalDr = report?.transactions.reduce((s, t) => s + t.debit, 0) || 0;
  const totalCr = report?.transactions.reduce((s, t) => s + t.credit, 0) || 0;

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
                  {costCentres.map(cc => <option key={cc.id} value={cc.code}>{cc.code} — {cc.name}</option>)}
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
                    <th className="px-4 py-3">Source</th>
                    <th className="px-4 py-3 text-right">Debit</th>
                    <th className="px-4 py-3 text-right">Credit</th>
                    <th className="px-4 py-3 text-right">Balance</th>
                  </tr></thead>
                  <tbody>
                    {report.transactions.length === 0 && <tr><td colSpan={7} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">No transactions</td></tr>}
                    {report.transactions.map((t, i) => (
                      <tr key={i} className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50">
                        <td className="px-4 py-2 text-[var(--ff-text-secondary)]">{t.date}</td>
                        <td className="px-4 py-2 text-[var(--ff-text-secondary)] font-mono text-xs">{t.entryNumber}</td>
                        <td className="px-4 py-2 text-[var(--ff-text-primary)] truncate max-w-[200px]">{t.description}</td>
                        <td className="px-4 py-2"><span className="px-2 py-0.5 rounded text-xs bg-[var(--ff-bg-primary)] text-[var(--ff-text-secondary)]">{t.source}</span></td>
                        <td className="px-4 py-2 text-right font-mono">{t.debit > 0 ? fmt(t.debit) : ''}</td>
                        <td className="px-4 py-2 text-right font-mono">{t.credit > 0 ? fmt(t.credit) : ''}</td>
                        <td className="px-4 py-2 text-right font-mono text-[var(--ff-text-primary)]">{fmt(t.balance)}</td>
                      </tr>
                    ))}
                    {report.transactions.length > 0 && (
                      <tr className="bg-[var(--ff-bg-primary)] font-medium">
                        <td colSpan={4} className="px-4 py-3 text-[var(--ff-text-primary)]">TOTAL</td>
                        <td className="px-4 py-3 text-right font-mono text-[var(--ff-text-primary)]">{fmt(totalDr)}</td>
                        <td className="px-4 py-3 text-right font-mono text-[var(--ff-text-primary)]">{fmt(totalCr)}</td>
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
