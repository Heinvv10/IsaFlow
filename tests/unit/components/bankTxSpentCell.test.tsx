/**
 * The golden specs that open a bank line's drawer pick "a spent line" by its Spent cell (`td[data-label="Spent"]` holding a
 * digit) and its Details button - NOT by a colour class, which the light-theme pairing (`text-red-700 dark:text-red-400`)
 * renamed. Pinned here, rendered, because the spec itself needs dev's Demo data.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { BankTxTable, type BankTx } from '@/components/accounting/BankTxTable';

const TXS: BankTx[] = [
  { id: 'in-1', description: 'Money in', amount: 250, transactionDate: '2026-06-02', status: 'imported', feedState: 'posted' },
  { id: 'out-1', description: 'Money out', amount: -100, transactionDate: '2026-06-01', status: 'imported', feedState: 'posted' },
];
const noop = () => {};

describe('the Spent cell the golden specs find a spent line by', () => {
  it('has data-label="Spent" and a digit only on the spent row, and its row has a Details button', () => {
    render(<BankTxTable transactions={TXS} glAccounts={[]} suppliers={[]} customers={[]} transferTargets={[]} cc1Options={[]} cc2Options={[]} buOptions={[]}
      selectedIds={new Set()} rowSelections={{}} allSelected={false} tab="new" onToggleSelect={noop} onSelectAll={noop} onRowTypeChange={noop}
      onRowEntityChange={noop} onRowVatChange={noop} onRowDimensionChange={noop} onAccept={noop} onExclude={noop} onUnmatch={noop} onSplit={noop} onOpenDetails={noop} />);
    const rows = screen.getAllByRole('row').filter(r => r.querySelector('td'));
    const spentRows = rows.filter(r => /\d/.test(r.querySelector('td[data-label="Spent"]')?.textContent ?? ''));
    expect(spentRows).toHaveLength(1);
    expect(within(spentRows[0]!).getByRole('button', { name: /^Details, / })).toBeTruthy();
    // the colour is a themed pair, so a spec must not match a bare colour class
    const cell = spentRows[0]!.querySelector('td[data-label="Spent"]')!;
    expect(cell.className).toMatch(/text-red-700 dark:text-red-400/);
    expect(cell.classList.contains('text-red-400')).toBe(false);
  });
});
