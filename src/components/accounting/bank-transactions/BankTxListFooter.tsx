/**
 * BankTxListFooter - the line under the bank transactions list (WP4b): rows per page (25 / 50 / 100, kept in the URL
 * as `size`), the table density toggle (the shared TableDensityContext one, offered only where a provider is mounted:
 * the bank grid's selects and rows follow it), and the company-wide coding-metrics line, moved here from above the
 * list so the list starts higher.
 */

import { Select, type SelectOption } from '@/components/ui/Select';
import { TableDensityToggle } from '@/components/ui/TableDensityToggle';
import { useOptionalTableDensity } from '@/contexts/TableDensityContext';
import { CodingMetricsStrip } from './CodingMetricsStrip';
import { BANK_TX_PAGE_SIZES, type BankTxPageSize } from './bankTxUrlState';

const SIZES: SelectOption[] = BANK_TX_PAGE_SIZES.map(n => ({ value: String(n), label: String(n) }));

interface Props {
  pageSize: BankTxPageSize;
  onPageSize: (n: BankTxPageSize) => void;
}

export function BankTxListFooter({ pageSize, onPageSize }: Props) {
  const density = useOptionalTableDensity();
  const choose = (v: string | null) => {
    const n = BANK_TX_PAGE_SIZES.find(s => String(s) === v);
    if (n) onPageSize(n);
  };
  return (
    <div data-testid="bank-tx-list-footer" className="flex flex-wrap items-center gap-x-6 gap-y-2 px-6 py-2 border-t border-[var(--ff-border-light)]">
      <div className="flex items-center gap-2 text-xs text-[var(--ff-text-secondary)]">
        <span aria-hidden="true">Rows per page</span>
        <Select label="Rows per page" labelClassName="sr-only" size="sm" className="w-20" options={SIZES} value={String(pageSize)} onChange={choose} />
      </div>
      {density && (
        <div className="flex items-center gap-2 text-xs text-[var(--ff-text-secondary)]">
          <span aria-hidden="true">Density</span>
          <TableDensityToggle />
        </div>
      )}
      <div className="ml-auto"><CodingMetricsStrip /></div>
    </div>
  );
}
