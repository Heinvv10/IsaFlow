/** Paged source lines under a VAT201 field: each row links to its journal entry. */
import Link from 'next/link';
import { formatMoney } from '@/lib/money/formatMoney';
import { formatDate } from '@/utils/formatters';
import type { Vat201DrillResult } from '@/modules/accounting/services/reports/vat201FieldDrill';

type LineResult = Extract<Vat201DrillResult, { source: 'tax-lines' | 'nil-rated' }>;

export function DrillLinesTable({ result }: { result: LineResult }) {
  const tax = result.source === 'tax-lines';
  return (
    <div>
      {result.rows.length > 0 && (
        <p className="mb-1 text-xs text-[var(--ff-text-secondary)] sm:hidden">Scroll sideways for every column.</p>
      )}
      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={`Lines behind field ${result.field}`}>
        <table className="w-full min-w-[560px] text-xs" data-testid="return-drill-lines">
          <thead>
            <tr className="text-left text-[var(--ff-text-secondary)]">
              <th scope="col" className="py-1 pr-2 font-medium">Entry</th>
              <th scope="col" className="py-1 pr-2 font-medium">Date</th>
              <th scope="col" className="py-1 pr-2 font-medium">Account</th>
              <th scope="col" className="py-1 pr-2 text-right font-medium">{tax ? 'VAT' : 'Amount'}</th>
              {tax && <th scope="col" className="py-1 text-right font-medium">Supply value (excl. VAT)</th>}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((r) => (
              <tr key={r.lineId} className="border-t border-[var(--ff-border-light)] text-[var(--ff-text-primary)]">
                <td className="whitespace-nowrap py-1 pr-2">
                  <Link href={`/accounting/journal-entries/${r.journalEntryId}`} className="inline-flex min-h-[24px] items-center text-teal-700 underline dark:text-teal-400">
                    {r.entryNumber}
                  </Link>
                </td>
                <td className="whitespace-nowrap py-1 pr-2">{formatDate(r.entryDate)}</td>
                <td className="py-1 pr-2">
                  {r.accountCode} {r.accountName}
                  {'residual' in r && r.residual && <span className="ml-1 text-[var(--ff-text-secondary)]">(residual, box {r.box})</span>}
                </td>
                <td className="whitespace-nowrap py-1 pr-2 text-right tabular-nums">{formatMoney('tax' in r ? r.tax : r.amount)}</td>
                {'journalBase' in r && <td className="whitespace-nowrap py-1 text-right tabular-nums">{formatMoney(r.journalBase)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {result.rows.length === 0 && <p className="py-2 text-xs text-[var(--ff-text-secondary)]">No lines in this period.</p>}
    </div>
  );
}
