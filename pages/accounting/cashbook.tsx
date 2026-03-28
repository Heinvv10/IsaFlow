/**
 * Cashbook Page — Filtered bank transaction ledger per bank account + date range
 * Shows deposits, withdrawals, running balance
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { ExportCSVButton } from '@/components/shared/ExportCSVButton';
import { BookOpen, Loader2, AlertCircle, Filter } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

interface BankAcct {
  id: string;
  accountCode: string;
  accountName: string;
  balance: number;
}

interface Tx {
  id: string;
  transactionDate: string;
  reference: string;
  description: string;
  amount: number;
  status: string;
  matchedEntity?: string;
}

function getDefaultDates() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  return {
    from: start.toISOString().split('T')[0],
    to: now.toISOString().split('T')[0],
  };
}

export default function CashbookPage() {
  const defaults = getDefaultDates();
  const [bankAccounts, setBankAccounts] = useState<BankAcct[]>([]);
  const [selectedBank, setSelectedBank] = useState('');
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const [transactions, setTransactions] = useState<Tx[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    apiFetch('/api/accounting/bank-accounts', { credentials: 'include' })
      .then(r => r.json())
      .then(json => {
        const list = Array.isArray(json.data || json) ? (json.data || json) : [];
        setBankAccounts(list);
        if (list.length > 0 && !selectedBank) setSelectedBank(list[0].id);
      })
      .catch(() => { /* reference data load failure — non-critical, bank account selector will be empty */ });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(async () => {
    if (!selectedBank) return;
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({
        bank_account_id: selectedBank,
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        limit: '500',
      });
      const res = await apiFetch(`/api/accounting/bank-transactions?${params}`, { credentials: 'include' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message || 'Failed to load');
      const data = json.data || json;
      setTransactions(Array.isArray(data) ? data : data.items || data.transactions || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setLoading(false);
    }
  }, [selectedBank, from, to]);

  useEffect(() => { load(); }, [load]);

  let runningBalance = 0;
  const rows = transactions
    .sort((a, b) => new Date(a.transactionDate).getTime() - new Date(b.transactionDate).getTime())
    .map(tx => {
      const amt = Number(tx.amount || 0);
      runningBalance += amt;
      return { ...tx, deposit: amt > 0 ? amt : 0, withdrawal: amt < 0 ? Math.abs(amt) : 0, balance: runningBalance };
    });

  const totals = rows.reduce((a, r) => ({
    deposits: a.deposits + r.deposit,
    withdrawals: a.withdrawals + r.withdrawal,
  }), { deposits: 0, withdrawals: 0 });

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10">
                <BookOpen className="h-6 w-6 text-teal-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Cashbook</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  {rows.length} transactions
                </p>
              </div>
            </div>
            <ExportCSVButton
              endpoint="/api/accounting/bank-transactions-export"
              filenamePrefix="cashbook"
              params={{ bank_account_id: selectedBank, from, to }}
            />
          </div>
        </div>

        <div className="p-6 space-y-4">
          <div className="flex items-center gap-3 flex-wrap">
            <Filter className="h-4 w-4 text-[var(--ff-text-tertiary)]" />
            <select
              value={selectedBank}
              onChange={e => setSelectedBank(e.target.value)}
              className="ff-select text-sm"
            >
              {bankAccounts.map(b => (
                <option key={b.id} value={b.id}>
                  {b.accountName} ({b.accountCode})
                </option>
              ))}
            </select>
            <input type="date" value={from} onChange={e => setFrom(e.target.value)} className="ff-input text-sm" />
            <span className="text-[var(--ff-text-tertiary)]">to</span>
            <input type="date" value={to} onChange={e => setTo(e.target.value)} className="ff-input text-sm" />
          </div>

          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">
              <AlertCircle className="h-4 w-4" /> {error}
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-teal-500" />
            </div>
          ) : rows.length === 0 ? (
            <div className="text-center py-12 text-[var(--ff-text-secondary)]">
              No transactions for selected period
            </div>
          ) : (
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)]">
                    <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Date</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Reference</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Description</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Deposits</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Withdrawals</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--ff-border-light)]">
                  {rows.map(r => (
                    <tr key={r.id} className="hover:bg-[var(--ff-bg-tertiary)] transition-colors">
                      <td className="px-4 py-3 text-[var(--ff-text-primary)]">{r.transactionDate?.split('T')[0]}</td>
                      <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{r.reference || '—'}</td>
                      <td className="px-4 py-3 text-[var(--ff-text-primary)]">{r.description || r.matchedEntity || '—'}</td>
                      <td className="px-4 py-3 text-right font-mono text-green-400">
                        {r.deposit > 0 ? fmt(r.deposit) : ''}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-red-400">
                        {r.withdrawal > 0 ? fmt(r.withdrawal) : ''}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-[var(--ff-text-primary)]">
                        {fmt(r.balance)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-[var(--ff-border-medium)] bg-[var(--ff-bg-tertiary)] font-bold">
                    <td colSpan={3} className="px-4 py-3 text-[var(--ff-text-primary)]">TOTALS</td>
                    <td className="px-4 py-3 text-right font-mono text-green-400">{fmt(totals.deposits)}</td>
                    <td className="px-4 py-3 text-right font-mono text-red-400">{fmt(totals.withdrawals)}</td>
                    <td className="px-4 py-3 text-right font-mono text-[var(--ff-text-primary)]">
                      {rows.length > 0 ? fmt(rows[rows.length - 1]?.balance ?? 0) : fmt(0)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
