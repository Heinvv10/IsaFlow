// The screen and the CSV export must show the same opening/closing rows for the same page.
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AccountLedgerTable } from '@/components/reports/AccountLedgerTable';
import { buildAccountLedgerCsv } from '@/lib/csv/accountLedgerCsv';
import type { AccountLedgerMeta, AccountLedgerRow } from '@/modules/accounting/services/reports/accountLedgerTypes';

const meta: AccountLedgerMeta = { accountId: 'a', accountCode: '4000', accountName: 'Sales', accountType: 'revenue', normalBalance: 'credit' };
const row = (date: string, credit: number, runningBalance: number): AccountLedgerRow => ({
  journalEntryId: `j${date}`, entryDate: date, entryNumber: 'JE', description: 'sale', reference: '', source: 'manual',
  debit: 0, credit, runningBalance,
});
const close: AccountLedgerRow = {
  journalEntryId: '', entryDate: '2025-02-28', entryNumber: '', description: 'Closed (derived — not posted)', reference: '',
  source: 'year_end_close', debit: 130, credit: 0, runningBalance: 0, derived: true,
};
// Opening 100; +10, +20, close, +5, +7; pages of 2.
const pages = [[row('2025-01-10', 10, 110), row('2025-02-10', 20, 130)], [close, row('2025-03-05', 5, 5)], [row('2025-04-05', 7, 12)]];
const fmt = (n: number) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

function screenBoundaries(page: number) {
  const { container, unmount } = render(
    <AccountLedgerTable rows={pages[page - 1]!} openingBalance={100} periodClosingBalance={12} page={page} totalPages={3}
      onPageChange={() => undefined} normalBalance="credit" />,
  );
  const cells = Array.from(container.querySelectorAll('tbody tr')).map(tr => tr.textContent ?? '');
  const out = { first: cells[0]!, last: cells[cells.length - 1]! };
  unmount();
  return out;
}

describe('AccountLedgerTable page boundaries match the CSV', () => {
  it.each([[1, 'Opening Balance', 100, 'Balance Carried Forward', 130], [2, 'Balance Brought Forward', 130, 'Balance Carried Forward', 5],
    [3, 'Balance Brought Forward', 5, 'Closing Balance', 12]])(
    'page %i: %s %d ... %s %d', (page, openLabel, openValue, closeLabel, closeValue) => {
      const s = screenBoundaries(page);
      expect(s.first).toContain(openLabel);
      expect(s.first).toContain(fmt(openValue));
      expect(s.last).toContain(closeLabel);
      expect(s.last).toContain(fmt(closeValue));
      // ...and the CSV for the same page says the same.
      const csv = buildAccountLedgerCsv(meta, pages[page - 1]!, 100, 12, { page, totalPages: 3 }).split('\n');
      expect(csv[1]).toContain(openLabel);
      expect(csv[1]).toContain(openValue.toFixed(2));
      expect(csv[csv.length - 1]).toContain(closeLabel);
      expect(csv[csv.length - 1]).toContain(closeValue.toFixed(2));
    }, 10000);

  it('does not say Opening Balance on page 2 or Closing Balance before the last page', () => {
    render(<AccountLedgerTable rows={pages[1]!} openingBalance={100} periodClosingBalance={12} page={2} totalPages={3}
      onPageChange={() => undefined} normalBalance="credit" />);
    expect(screen.queryByText('Opening Balance')).toBeNull();
    expect(screen.queryByText(/Closing Balance/)).toBeNull();
    expect(within(document.body).getByText('Balance Brought Forward')).toBeTruthy();
  });
});
