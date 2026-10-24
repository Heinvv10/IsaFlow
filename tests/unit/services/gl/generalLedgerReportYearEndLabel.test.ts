import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));

import { withYearEndCloses } from '@/modules/accounting/services/gl/generalLedgerReportYearEnd';
import { broughtForwardLine } from '@/modules/accounting/services/gl/trialBalanceBasis';
import type { GeneralLedgerAccountReport } from '@/modules/accounting/services/gl/generalLedgerReportService';

// Expense account, FY starts March. A range 2022-12-01..2023-05-31 crosses the 2023-03-01 start
// (fiscalYearStartsWithin gives [2023-03-01]); 2022-12-01..2023-02-28 crosses none ([]).
const expense = (): GeneralLedgerAccountReport => ({
  accountCode: '5000', accountName: 'Labour', accountType: 'expense', openingBalance: 40, closingBalance: 70,
  totalDebit: 30, totalCredit: 0,
  transactions: [
    { date: '2022-12-10', entryNumber: 'JE1', description: 'wages', debit: 30, credit: 0, balance: 70, source: 'manual' },
  ],
});
const run = (boundaries: string[]) => withYearEndCloses([expense()], {
  accounts: new Map([['5000', { type: 'expense', normalBalance: 'debit' }]]),
  boundaries,
  retainedEarnings: { ...broughtForwardLine('2022-03-01'), openingBalance: -100 },
}).find(a => a.accountCode === 'RE-BF')!;

describe('RE-BF label says what the figure shown against it is', () => {
  it('inside one fiscal year the figure is the opening: profit before the FY start', () => {
    const re = run([]);
    expect(re.transactions).toEqual([]);
    expect(re.accountName).toContain('profit before 2022-03-01');
  });

  it('across a fiscal-year start the figure is that opening PLUS the years closed in the range, and the label says so', () => {
    const re = run(['2023-03-01']);
    expect(re.transactions).toHaveLength(1);
    expect(re.openingBalance).toBe(-100);
    expect(re.closingBalance).toBe(-100 - 70);
    expect(re.accountName).toContain('profit before 2022-03-01');
    expect(re.accountName).toMatch(/plus fiscal years closed in this range/);
    expect(re.accountName).not.toContain(',');   // the label is a CSV field in the CaseWare export
  });
});
