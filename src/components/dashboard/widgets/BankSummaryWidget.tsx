/**
 * BankSummaryWidget — Shows bank account balances from /api/accounting/bank-accounts.
 * // WORKING: Self-contained data fetch, skeleton loading, dark mode.
 */

import { useEffect, useState } from 'react';
import { Landmark, TrendingUp } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';

interface BankAccount {
  id: string;
  account_name: string;
  account_code: string;
  bank_account_number: string | null;
  statement_balance: number;
  gl_balance: number;
  difference: number;
}

function fmtCurrency(n: number): string {
  return 'R\u00a0' + new Intl.NumberFormat('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

export function BankSummaryWidget() {
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const res = await apiFetch('/api/accounting/bank-accounts');
        const json = (await res.json()) as { data?: BankAccount[] };
        const data = json.data ?? [];
        setAccounts(data);
      } catch (err) {
        log.error('BankSummaryWidget fetch failed', { error: err }, 'dashboard-widget');
        setError('Unable to load bank accounts');
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, []);

  const totalGL = accounts.reduce((s, a) => s + (a.gl_balance ?? 0), 0);

  return (
    <Card
      header={
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Landmark className="h-4 w-4 text-teal-500" />
            <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">Bank Accounts</span>
          </div>
          {!loading && !error && (
            <span className="text-xs font-medium text-teal-600 dark:text-teal-400">{fmtCurrency(totalGL)}</span>
          )}
        </div>
      }
      noPadding
    >
      {loading ? (
        <div className="p-4 space-y-3">
          <Skeleton variant="text" />
          <Skeleton variant="text" />
          <Skeleton variant="text" />
        </div>
      ) : error ? (
        <p className="p-4 text-sm text-red-500">{error}</p>
      ) : accounts.length === 0 ? (
        <p className="p-4 text-sm text-gray-500 dark:text-gray-400">No bank accounts found.</p>
      ) : (
        <div className="divide-y divide-gray-100 dark:divide-gray-700">
          {accounts.map(account => {
            const lastFour = account.bank_account_number?.slice(-4) ?? '----';
            const diff = account.difference ?? 0;
            const inBalance = Math.abs(diff) < 0.01;
            return (
              <div key={account.id} className="px-4 py-3 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                    {account.account_name}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {account.account_code} &bull; &bull;&bull;&bull;&bull; {lastFour}
                  </p>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                    {fmtCurrency(account.gl_balance ?? 0)}
                  </p>
                  {!inBalance && (
                    <p className="text-xs text-amber-500 flex items-center justify-end gap-1">
                      <TrendingUp className="h-3 w-3" />
                      {diff > 0 ? '+' : ''}{fmtCurrency(diff)}
                    </p>
                  )}
                  {inBalance && (
                    <p className="text-xs text-green-500">Reconciled</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
