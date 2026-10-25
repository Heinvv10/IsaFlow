/**
 * The lines of one journal entry, with their totals — the table on the journal
 * entry detail page, split out of the page for the 300-line cap (R-035 PR6).
 */
import type { JournalLine } from '@/modules/accounting/types/gl.types';

interface Props {
  lines: JournalLine[];
  formatCurrency: (amount: number | string) => string;
}

export function JournalLinesTable({ lines, formatCurrency }: Props) {
  return (
    <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
      <div className="px-6 py-4 border-b border-[var(--ff-border-light)]">
        <h3 className="text-lg font-semibold text-[var(--ff-text-primary)]">Journal Lines</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="bg-[var(--ff-bg-tertiary)] border-b border-[var(--ff-border-light)]">
              <th className="px-6 py-3 text-left text-xs tracking-[0.12em] font-semibold uppercase text-[var(--ff-text-secondary)]">#</th>
              <th className="px-6 py-3 text-left text-xs tracking-[0.12em] font-semibold uppercase text-[var(--ff-text-secondary)]">Account</th>
              <th className="px-6 py-3 text-left text-xs tracking-[0.12em] font-semibold uppercase text-[var(--ff-text-secondary)]">Description</th>
              <th className="px-6 py-3 text-right text-xs tracking-[0.12em] font-semibold uppercase text-[var(--ff-text-secondary)]">Debit</th>
              <th className="px-6 py-3 text-right text-xs tracking-[0.12em] font-semibold uppercase text-[var(--ff-text-secondary)]">Credit</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, idx) => (
              <tr key={line.id} className="border-b border-[var(--ff-border-light)] hover:bg-teal-500/[0.04] transition-colors">
                <td className="px-6 py-3 text-sm text-[var(--ff-text-tertiary)]">{idx + 1}</td>
                <td className="px-6 py-3">
                  <div className="text-sm font-medium text-[var(--ff-text-primary)]">{line.accountCode || '-'}</div>
                  <div className="text-xs text-[var(--ff-text-secondary)]">{line.accountName || ''}</div>
                </td>
                <td className="px-6 py-3 text-sm text-[var(--ff-text-primary)]">{line.description || '-'}</td>
                <td className="px-6 py-3 text-sm text-right font-medium tabular-nums text-[var(--ff-text-primary)]">
                  {formatCurrency(line.debit)}
                </td>
                <td className="px-6 py-3 text-sm text-right font-medium tabular-nums text-[var(--ff-text-primary)]">
                  {formatCurrency(line.credit)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-[var(--ff-bg-tertiary)] border-t-2 border-[var(--ff-border-medium)]">
              <td colSpan={3} className="px-6 py-3 text-sm font-semibold text-[var(--ff-text-primary)]">Total</td>
              <td className="px-6 py-3 text-sm text-right font-bold text-[var(--ff-text-primary)]">
                {formatCurrency(lines.reduce((s, l) => s + Number(l.debit), 0) || 0)}
              </td>
              <td className="px-6 py-3 text-sm text-right font-bold text-[var(--ff-text-primary)]">
                {formatCurrency(lines.reduce((s, l) => s + Number(l.credit), 0) || 0)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
