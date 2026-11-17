/**
 * BankTxListFooter - the line under the bank transactions list (WP4b): rows per page (25 / 50 / 100: in the URL as
 * `size` and remembered in this browser, the URL winning) and the company-wide coding-metrics line, moved here from
 * above the list so the list starts higher. Density has ONE toggle, the header's (TableDensityContext): the bank grid
 * follows it (xs selects and 33px rows in compact, bankTxSelectionPopoverUxb.test, golden z15).
 */

import { Select, type SelectOption } from '@/components/ui/Select';
import { CodingMetricsStrip } from './CodingMetricsStrip';
import { BANK_TX_PAGE_SIZES, type BankTxPageSize } from './bankTxUrlState';

const SIZES: SelectOption[] = BANK_TX_PAGE_SIZES.map(n => ({ value: String(n), label: String(n) }));

interface Props {
  pageSize: BankTxPageSize;
  onPageSize: (n: BankTxPageSize) => void;
}

export function BankTxListFooter({ pageSize, onPageSize }: Props) {
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
      <div className="ml-auto"><CodingMetricsStrip /></div>
    </div>
  );
}
