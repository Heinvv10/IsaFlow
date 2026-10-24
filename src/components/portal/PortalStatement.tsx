/**
 * Client Portal — account statement.
 *
 * Renders what /api/portal/statement returns, which is the emailed statement
 * (statementEmailService.fetchStatementData) for the same customer and date.
 * The closing balance shown here is the figure the customer is asked to pay;
 * nothing on this component recomputes it.
 */

import { Loader2, ScrollText } from 'lucide-react';
import { formatMoney } from '@/lib/money/formatMoney';

export interface PortalStatementData {
  asOfDate: string;
  openingBalance: number;
  closingBalance: number;
  overdueAmount: number;
  transactions: Array<{
    date: string;
    reference: string;
    description: string;
    debit: number;
    credit: number;
    balance: number;
  }>;
}

/** 'R 1 234.56'; a negative balance is money the customer holds in credit. */
export function formatBalance(amount: number): string {
  const text = formatMoney(Math.abs(amount));
  return amount < 0 ? `${text} CR` : text;
}

/** YYYY-MM-DD shown as-is (en-ZA order), never re-parsed through Date and a browser timezone. */
export function formatIsoDate(iso: string): string {
  return iso.replace(/-/g, '/');
}

interface Props {
  statement: PortalStatementData | null;
  loading: boolean;
  error: string;
}

export function PortalStatement({ statement, loading, error }: Props) {
  const th = 'px-6 py-3 font-medium text-slate-500 dark:text-gray-400';
  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex items-center gap-2">
        <ScrollText className="h-5 w-5 text-slate-500 dark:text-gray-400" />
        <h2 className="text-lg font-semibold text-slate-900 dark:text-white">Statement</h2>
        {statement && (
          <span className="ml-auto text-xs text-slate-500 dark:text-gray-500">As at {formatIsoDate(statement.asOfDate)}</span>
        )}
      </div>
      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-teal-500" />
        </div>
      ) : error ? (
        <div className="px-6 py-12 text-center text-red-500">{error}</div>
      ) : !statement || statement.transactions.length === 0 ? (
        <div className="px-6 py-12 text-center text-slate-500 dark:text-gray-500">No transactions on your statement</div>
      ) : (
        <table className="w-full text-sm" data-testid="portal-statement">
          <thead>
            <tr className="bg-slate-50 dark:bg-gray-800/50">
              <th className={`text-left ${th}`}>Date</th>
              <th className={`text-left ${th}`}>Reference</th>
              <th className={`text-left ${th}`}>Type</th>
              <th className={`text-right ${th}`}>Debit</th>
              <th className={`text-right ${th}`}>Credit</th>
              <th className={`text-right ${th}`}>Balance</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
            <tr>
              <td className="px-6 py-3 text-slate-600 dark:text-gray-300" colSpan={5}>Opening balance</td>
              <td className="px-6 py-3 text-right text-slate-600 dark:text-gray-300">{formatBalance(statement.openingBalance)}</td>
            </tr>
            {statement.transactions.map((t, i) => (
              <tr key={`${t.reference}-${i}`}>
                <td className="px-6 py-3 text-slate-600 dark:text-gray-300">{formatIsoDate(t.date)}</td>
                <td className="px-6 py-3 text-slate-900 dark:text-white font-medium">{t.reference}</td>
                <td className="px-6 py-3 text-slate-600 dark:text-gray-300">{t.description}</td>
                <td className="px-6 py-3 text-right text-slate-600 dark:text-gray-300">{t.debit ? formatBalance(t.debit) : ''}</td>
                <td className="px-6 py-3 text-right text-slate-600 dark:text-gray-300">{t.credit ? formatBalance(t.credit) : ''}</td>
                <td className="px-6 py-3 text-right text-slate-600 dark:text-gray-300">{formatBalance(t.balance)}</td>
              </tr>
            ))}
            <tr className="bg-slate-50 dark:bg-gray-800/50">
              <td className="px-6 py-3 font-semibold text-slate-900 dark:text-white" colSpan={5}>Closing balance</td>
              <td className="px-6 py-3 text-right font-semibold text-slate-900 dark:text-white" data-testid="portal-closing-balance">
                {formatBalance(statement.closingBalance)}
              </td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  );
}
