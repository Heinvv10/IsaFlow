/**
 * The two PDF parsers that read the printed "balance brought forward" report it as `openingBalance`, and
 * ABSA's, which derives each amount from the balances, keeps the amount the line printed. Both feed
 * nativeParseTrust, which uses them to see a dropped row that the balances alone cannot show.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { parseAbsaPdfText } from '@/modules/accounting/utils/bankPdfParserAbsa';
import { parseStandardBankStatement } from '@/modules/accounting/utils/bankPdfParserStandardBank';
import { nativeRowsAreComplete } from '@/modules/accounting/services/bank/nativeParseTrust';

const absa = (...rows: string[]) => ['Absa Bank Limited', '01/03/2026 Bal Brought Forward 1,000.00', ...rows].join('\n');
const SHOP = '02/03/2026 Shop Purchase 100.00 900.00';
const SALARY = '03/03/2026 Salary Credit 500.00 1,400.00';
const FEE = '04/03/2026 Monthly Fee 50.00 1,350.00';

describe('ABSA slash-date parser', () => {
  it('reports the balance brought forward and the amount each line printed', () => {
    const r = parseAbsaPdfText(absa(SHOP, SALARY, FEE));
    expect(r.openingBalance).toBe(1000);
    expect(r.transactions.map((t) => [t.amount, t.printedAmount, t.balance])).toEqual([
      [-100, 100, 900], [500, 500, 1400], [-50, 50, 1350],
    ]);
    expect(nativeRowsAreComplete({ ...r, parser: 'native' })).toBe(true);
  });

  it('a dropped middle row is absorbed into the next amount, and the printed amount shows it', () => {
    const r = parseAbsaPdfText(absa(SHOP, '04/03/2026 Monthly Fee 1,050.00 350.00'));
    // 900 -> 350 is -550 but the line printed 1,050.00: a 500 row between them is missing
    expect(r.transactions[1]!.amount).toBe(-550);
    expect(r.transactions[1]!.printedAmount).toBe(1050);
    expect(nativeRowsAreComplete({ ...r, parser: 'native' })).toBe(false);
  });

  it('a dropped first row is shown by the opening balance and the printed amount', () => {
    const r = parseAbsaPdfText(absa(SALARY, FEE));
    expect(nativeRowsAreComplete({ ...r, parser: 'native' })).toBe(false);
  });

  it('a statement with no brought-forward line: the first row\'s sign is unverified, so the rows are not trusted', () => {
    // Opened at 100, but nothing printed it: the parser reads the 10.00 debit as a credit (it has no balance to derive the sign from).
    const r = parseAbsaPdfText(['Absa Bank Limited', '15/03/2026 Shop Purchase 10.00 90.00', '16/03/2026 Fuel 5.00 85.00'].join('\n'));
    expect(r.openingBalance).toBeUndefined();
    expect(r.transactions.map((t) => [t.amount, t.balance, t.printedAmount])).toEqual([[10, 90, undefined], [-5, 85, 5]]);
    expect(nativeRowsAreComplete({ ...r, parser: 'native' })).toBe(false);
  });

  it('takes the opening balance from the first brought-forward line only', () => {
    const r = parseAbsaPdfText(absa(SHOP, '03/03/2026 Bal Brought Forward 777.00', SALARY));
    expect(r.openingBalance).toBe(1000);
  });
});

describe('ABSA investment-account parser (day, month name, year; comma decimals)', () => {
  const inv = (...rows: string[]) => ['Absa Bank Limited', 'Investment Account', '01 Mar 2026 Balance Brought Forward 1 000,00', ...rows].join('\n');
  const CREDIT = '02 Mar 2026 Deposit Credit 500,00 1 500,00';
  const DEBIT = '03 Mar 2026 Withdrawal Debit 200,00- 1 300,00';

  it('reports the balance brought forward and the amount each derived line printed', () => {
    const r = parseAbsaPdfText(inv(CREDIT, DEBIT));
    expect(r.openingBalance).toBe(1000);
    expect(r.transactions.map((t) => [t.amount, t.balance])).toEqual([[500, 1500], [-200, 1300]]);
    expect(r.transactions[0]!.printedAmount).toBe(500);
    expect(nativeRowsAreComplete({ ...r, parser: 'native' })).toBe(true);
  });

  it('takes only a brought-forward line as the opening balance, and only before the first row', () => {
    const total = parseAbsaPdfText(['Absa Bank Limited', 'Investment Account', '01 Mar 2026 Total Credits 777,00', CREDIT].join('\n'));
    expect(total.openingBalance).toBeUndefined();
    const late = parseAbsaPdfText(['Absa Bank Limited', 'Investment Account', CREDIT, '03 Mar 2026 Balance Brought Forward 999,00'].join('\n'));
    expect(late.openingBalance).toBeUndefined();
  });

  it('a dropped first row is shown by the opening balance', () => {
    const r = parseAbsaPdfText(inv(DEBIT));
    expect(nativeRowsAreComplete({ ...r, parser: 'native' })).toBe(false);
  });

  it('a dropped middle row is shown by the printed amount', () => {
    const r = parseAbsaPdfText(inv(CREDIT, '04 Mar 2026 Deposit Credit 100,00 1 900,00'));
    expect(r.transactions[1]!.amount).toBe(400);
    expect(nativeRowsAreComplete({ ...r, parser: 'native' })).toBe(false);
  });
});

describe('Standard Bank column-format parser', () => {
  const sb = (...rows: string[]) => [
    'The Standard Bank of South Africa Limited',
    '1 BALANCE BROUGHT FORWARD 0.00 0.00 0.00 20260301 1,000.00',
    ...rows,
  ].join('\n');
  const PAY = '1 PAYMENT TO SHOP 0.00 -100.00 0.00 20260302 900.00';
  const IN = '1 SALARY 0.00 0.00 500.00 20260303 1,400.00';

  it('reports the balance brought forward as the opening balance', () => {
    const r = parseStandardBankStatement(sb(PAY, IN));
    expect(r.openingBalance).toBe(1000);
    expect(r.transactions.map((t) => [t.amount, t.balance])).toEqual([[-100, 900], [500, 1400]]);
    expect(nativeRowsAreComplete({ ...r, parser: 'native' })).toBe(true);
  });

  it('takes only a BROUGHT FORWARD row as the opening balance, not another zero-movement row', () => {
    const r = parseStandardBankStatement([
      'The Standard Bank of South Africa Limited',
      '1 PAGE TOTAL 0.00 0.00 0.00 20260301 555.00',
      PAY,
    ].join('\n'));
    expect(r.openingBalance).toBeUndefined();
    // a brought-forward row after a transaction (a page break) is not where the statement opened
    const later = parseStandardBankStatement(['The Standard Bank of South Africa Limited', PAY,
      '1 BALANCE BROUGHT FORWARD 0.00 0.00 0.00 20260303 900.00'].join('\n'));
    expect(later.openingBalance).toBeUndefined();
  });

  it('a dropped first row is shown by the opening balance', () => {
    const r = parseStandardBankStatement(sb(IN, '1 FEE 0.00 -50.00 0.00 20260304 1,350.00'));
    expect(nativeRowsAreComplete({ ...r, parser: 'native' })).toBe(false);
  });
});
