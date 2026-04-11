/**
 * ConsolidatedTBTable — renders the consolidated trial balance result table.
 */

import type { ConsolidatedTrialBalance } from '@/modules/accounting/services/consolidationTypes';

const ACCOUNT_TYPE_COLOUR: Record<string, string> = {
  asset: 'text-blue-400', liability: 'text-orange-400', equity: 'text-purple-400',
  income: 'text-teal-400', expense: 'text-red-400',
};

const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

interface Props { report: ConsolidatedTrialBalance }

export function ConsolidatedTBTable({ report }: Props) {
  const { entities, accounts, totalDebits, totalCredits } = report;

  return (
    <>
      <div className="px-6 pb-2 text-xs text-gray-500">
        {report.groupName} — {report.periodStart} to {report.periodEnd}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-y border-white/5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
              <th className="sticky left-0 bg-[#1a1f2e] px-6 py-3 w-28">Code</th>
              <th className="px-3 py-3 min-w-[180px]">Account</th>
              <th className="px-3 py-3">Type</th>
              {entities.map((e) => (
                <th key={e.companyId} className="px-3 py-3 text-right" colSpan={2}>
                  <span className="block truncate max-w-[140px]" title={e.companyName}>{e.companyName}</span>
                  <span className="flex justify-end gap-4 text-[10px] font-normal text-gray-600 mt-0.5">
                    <span>DR</span><span>CR</span>
                  </span>
                </th>
              ))}
              <th className="px-3 py-3 text-right">Total DR</th>
              <th className="px-3 py-3 text-right">Total CR</th>
              <th className="px-3 py-3 text-center">Elim.</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {accounts.map((acc) => (
              <tr key={`${acc.accountCode}|${acc.accountType}`} className="hover:bg-white/[0.02] transition-colors">
                <td className="sticky left-0 bg-[#1a1f2e] px-6 py-2.5 font-mono text-xs text-gray-400">
                  {acc.accountCode}
                </td>
                <td className="px-3 py-2.5 font-medium text-gray-200">{acc.accountName}</td>
                <td className="px-3 py-2.5">
                  <span className={`capitalize text-xs ${ACCOUNT_TYPE_COLOUR[acc.accountType.toLowerCase()] ?? 'text-gray-400'}`}>
                    {acc.accountType}
                  </span>
                </td>
                {entities.map((e) => {
                  const bal = acc.byEntity[e.companyId] ?? { debit: 0, credit: 0 };
                  return (
                    <td key={e.companyId} className="px-3 py-2.5 text-right" colSpan={2}>
                      <span className="flex justify-end gap-4 font-mono text-xs text-gray-300">
                        <span>{bal.debit  ? fmt(bal.debit)  : '—'}</span>
                        <span>{bal.credit ? fmt(bal.credit) : '—'}</span>
                      </span>
                    </td>
                  );
                })}
                <td className="px-3 py-2.5 text-right font-mono text-xs font-semibold text-gray-200">
                  {fmt(acc.totalDebit)}
                </td>
                <td className="px-3 py-2.5 text-right font-mono text-xs font-semibold text-gray-200">
                  {fmt(acc.totalCredit)}
                </td>
                <td className="px-3 py-2.5 text-center">
                  {acc.isEliminated && (
                    <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-400">
                      Elim
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-white/20 bg-white/[0.03] font-semibold">
              <td
                className="sticky left-0 bg-[#1a1f2e] px-6 py-3 text-xs text-gray-400 uppercase tracking-wider"
                colSpan={3}
              >
                Totals
              </td>
              {entities.map((e) => <td key={e.companyId} colSpan={2} />)}
              <td className="px-3 py-3 text-right font-mono text-sm text-white">{fmt(totalDebits)}</td>
              <td className="px-3 py-3 text-right font-mono text-sm text-white">{fmt(totalCredits)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  );
}
