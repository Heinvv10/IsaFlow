/**
 * LoanScheduleTable — renders the amortisation schedule rows.
 * Colour-coded: skip=amber, lump=blue highlight, nca_flagged=red border.
 */

import { Loader2 } from 'lucide-react';
import { ScheduleRow, fmt, fmtPct, fmtDate } from './types';

interface Props {
  rows: ScheduleRow[];
  loading: boolean;
}

export function LoanScheduleTable({ rows, loading }: Props) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-[var(--ff-text-tertiary)]">
        <Loader2 className="h-5 w-5 animate-spin mr-2" /> Computing schedule…
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <p className="py-8 text-center text-[var(--ff-text-tertiary)] text-sm">
        No schedule rows found.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs min-w-[900px]">
        <thead>
          <tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
            {['#', 'Date', 'Opening', 'Rate', 'Installment', 'Interest', 'Principal', 'Lump', 'Payment', 'Closing', 'ST Liability'].map(h => (
              <th key={h} className={`px-3 py-2 whitespace-nowrap ${['Opening','Installment','Interest','Principal','Lump','Payment','Closing','ST Liability'].includes(h) ? 'text-right' : ''}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(row => {
            const rowCls = [
              'border-b border-[var(--ff-border-light)]',
              row.nca_flagged ? 'border-l-2 border-l-red-500' : '',
              row.skip ? 'bg-amber-500/5 text-[var(--ff-text-tertiary)]' : 'hover:bg-[var(--ff-bg-primary)]/50',
              row.lump > 0 ? 'bg-blue-500/5' : '',
            ].join(' ');

            return (
              <tr key={row.period} className={rowCls}>
                <td className="px-3 py-2 text-[var(--ff-text-secondary)]">{row.period}</td>
                <td className="px-3 py-2 whitespace-nowrap text-[var(--ff-text-primary)]">{fmtDate(row.date)}</td>
                <td className="px-3 py-2 text-right text-[var(--ff-text-primary)]">{fmt(row.opening)}</td>
                <td className="px-3 py-2 text-right text-[var(--ff-text-secondary)]">{fmtPct(row.rate)}</td>
                <td className="px-3 py-2 text-right text-[var(--ff-text-primary)]">{fmt(row.installment)}</td>
                <td className="px-3 py-2 text-right text-amber-400">{fmt(row.interest)}</td>
                <td className="px-3 py-2 text-right text-teal-400">{fmt(row.principal)}</td>
                <td className="px-3 py-2 text-right text-blue-400">{row.lump > 0 ? fmt(row.lump) : '—'}</td>
                <td className="px-3 py-2 text-right text-[var(--ff-text-primary)]">{fmt(row.payment)}</td>
                <td className="px-3 py-2 text-right text-[var(--ff-text-primary)]">{fmt(row.closing)}</td>
                <td className="px-3 py-2 text-right text-[var(--ff-text-secondary)]">{fmt(row.stLiability)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
