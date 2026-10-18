/**
 * ABSA prints an overdrawn balance with a trailing minus ("45 574.41-"), and on some statements the pdf text layer
 * detaches it ("2 829.60 -"). The slash-date parser anchored its amount tail on the end of the line, so every row
 * that left the account overdrawn was dropped, the rows after it were mis-derived, and so was a negative balance
 * brought forward. The lines below keep the shape of a real statement's text layer (tab separated, the memo and
 * continuation lines, the "*" charge rows); account numbers, names and amounts are made up.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { parseAbsaPdfText } from '@/modules/accounting/utils/bankPdfParserAbsa';
import { nativeRowsAreComplete } from '@/modules/accounting/services/bank/nativeParseTrust';

const T = '\t';
const HEADER = [
  'Private Bag X18, Johannesburg, 2000',
  `Classic Business Acc ${T}18 Jul 2026`,
  `Balance Brought Forward ${T}10 000,00`,
  `Sundry Debits ${T}30 000,00-`,
  `Charges ${T}100,00-`,
];

/** Opens at 10 000.00, crosses into overdraft on the second row, and comes back out on the fourth. */
const OVERDRAWN_ROWS = [
  `19/06/2026 ${T}Bal Brought Forward ${T}10 000.00`,
  `22/06/2026 ${T}Digital Transf Cr ${T}Settlement ${T}5 000.00 ${T}15 000.00`,
  `4100000001 ${T}Test Payer One`,
  `1/07/2026 ${T}Int Debit Order To ${T}Settlement ${T}20 000.00 ${T}5 000.00-`,
  `Test Debtor 0000000001`,
  `1/07/2026 ${T}Int Debit Order To ${T}Settlement ${T}3 000.00 ${T}8 000.00-`,
  `Test Debtor ${T}00000000002`,
  `1/07/2026 ${T}Archive Stmt Enq ${T}Settlement ${T}10.00 A ${T}8 000.00-`,
  `2/07/2026 ${T}Acb Credit ${T}Settlement ${T}10 000.00 ${T}2 000.00`,
  `Test Payer Two`,
  `3/07/2026 ${T}Unauth Dr Bal Fee ${T}Headoffice ${T}* ${T}100.00 ${T}1 900.00`,
];

const parse = (...lines: string[]) => parseAbsaPdfText([...HEADER, ...lines].join('\n'));
const trusted = (r: ReturnType<typeof parse>) => nativeRowsAreComplete({ ...r, parser: 'native' });

describe('ABSA slash-date parser: overdrawn (trailing-minus) balances', () => {
  it('keeps the rows that leave the account overdrawn, with a negative balance and the derived debit', () => {
    const r = parse(...OVERDRAWN_ROWS);
    expect(r.errors).toEqual([]);
    expect(r.transactions.map((t) => [t.amount, t.balance])).toEqual([
      [5000, 15000], [-20000, -5000], [-3000, -8000], [10000, 2000], [-100, 1900],
    ]);
    expect(trusted(r)).toBe(true);
  });

  it('keeps the printed amount of a row that was overdrawn, and its continuation line with it', () => {
    const r = parse(...OVERDRAWN_ROWS);
    expect(r.transactions[1]!.printedAmount).toBe(20000);
    expect(r.transactions[1]!.description).toContain('Test Debtor 0000000001');
    expect(r.transactions[2]!.description).toContain('Test Debtor');
  });

  it('a memo row (one figure, an overdrawn balance) is not a transaction', () => {
    const r = parse(...OVERDRAWN_ROWS);
    expect(r.transactions.some((t) => /Archive Stmt/.test(t.description))).toBe(false);
  });

  it('reads a minus the text layer detached from the balance ("8 000.00 -")', () => {
    const r = parse(
      OVERDRAWN_ROWS[0]!,
      `1/07/2026 ${T}Acb Debit:External ${T}Settlement ${T}12 000.00 ${T}2 000.00 -`,
      `1/07/2026 ${T}Unauth Dr Bal Fee ${T}Headoffice ${T}* ${T}156.55 ${T}2 156.55 -`,
    );
    expect(r.transactions.map((t) => [t.amount, t.balance])).toEqual([[-12000, -2000], [-156.55, -2156.55]]);
    expect(trusted(r)).toBe(true);
  });

  it('a negative balance brought forward is the opening balance, so the first row is tied to it', () => {
    const r = parse(
      `30/06/2026 ${T}Bal Brought Forward ${T}55 837.62-`,
      `30/06/2026 ${T}Immediate Trf Cr Ec ${T}25 000.00 ${T}30 837.62-`,
      `1/07/2026 ${T}Int Debit Order To ${T}Settlement ${T}1 000.00 ${T}31 837.62-`,
    );
    expect(r.openingBalance).toBe(-55837.62);
    expect(r.transactions.map((t) => [t.amount, t.balance])).toEqual([[25000, -30837.62], [-1000, -31837.62]]);
    expect(trusted(r)).toBe(true);
  });

  it('a negative brought-forward line later in the text is still not the opening balance', () => {
    const r = parse(...OVERDRAWN_ROWS, `4/07/2026 ${T}Bal Brought Forward ${T}777.00-`);
    expect(r.openingBalance).toBe(10000);
  });

  it('a row dropped between two overdrawn balances is still caught', () => {
    const r = parse(OVERDRAWN_ROWS[0]!, OVERDRAWN_ROWS[3]!, `1/07/2026 ${T}Int Debit Order To ${T}Settlement ${T}4 000.00 ${T}12 000.00-`);
    expect(r.transactions[1]!.amount).toBe(-7000);
    expect(r.transactions[1]!.printedAmount).toBe(4000);
    expect(trusted(r)).toBe(false);
  });

  it('a positive statement reads as before', () => {
    const r = parse(OVERDRAWN_ROWS[0]!, OVERDRAWN_ROWS[1]!, `3/07/2026 ${T}Acb Debit:External ${T}Settlement ${T}1 000.00 ${T}14 000.00`);
    expect(r.transactions.map((t) => [t.amount, t.balance])).toEqual([[5000, 15000], [-1000, 14000]]);
    expect(trusted(r)).toBe(true);
  });
});

describe('ABSA investment-account parser: overdrawn (trailing-minus) balances', () => {
  const inv = (...rows: string[]) => ['Absa Bank Limited', 'Investment Account', ...rows].join('\n');

  it('a negative balance brought forward and a negative running balance keep their sign', () => {
    const r = parseAbsaPdfText(inv(
      '01 Mar 2026 Balance Brought Forward 1 000,00-',
      '02 Mar 2026 Deposit Credit 400,00 600,00-',
      '03 Mar 2026 Withdrawal Debit 200,00- 800,00-',
    ));
    expect(r.openingBalance).toBe(-1000);
    expect(r.transactions.map((t) => [t.amount, t.balance])).toEqual([[400, -600], [-200, -800]]);
    expect(trusted(r)).toBe(true);
  });
});
