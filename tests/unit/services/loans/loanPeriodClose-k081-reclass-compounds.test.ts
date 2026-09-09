/**
 * K-081 RED — the current-portion reclass is re-posted in full every month.
 *
 * buildReclassificationInput posts DR loan liability / CR current portion for
 * the WHOLE st_liability on the schedule row for the period. closeLoanPeriod
 * runs it once per month and nothing ever reverses or nets off the previous
 * month's entry, so the current-portion account accumulates one full year's
 * instalments per month of trading.
 *
 * The reclass is a restatement of a balance, not a transaction: after closing
 * February the current-portion account must hold February's twelve-month
 * figure, not January's plus February's. Only the movement between the two
 * belongs in the journal.
 *
 * Both legs are liabilities, so the trial balance still foots and the total owed
 * is unchanged — the damage is confined to the current / non-current split on
 * the balance sheet, where the non-current account eventually runs to a debit
 * balance. It is an AFS presentation error, and it grows every close.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock, createJournalEntryMock, postJournalEntryMock } = vi.hoisted(() => ({
  sqlMock: vi.fn(),
  createJournalEntryMock: vi.fn(),
  postJournalEntryMock: vi.fn(),
}));

vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/accounting/services/gl/journalEntryCrudService', () => ({
  createJournalEntry: createJournalEntryMock,
}));
vi.mock('@/modules/accounting/services/gl/journalEntryPostingService', () => ({
  postJournalEntry: postJournalEntryMock,
}));

import { closeLoanPeriod } from '@/modules/accounting/services/loans/loanPeriodCloseService';

const COMPANY = 'aaaaaaaa-0000-0000-0000-000000000001';
const LOAN = 'bbbbbbbb-0000-0000-0000-000000000002';
const USER = 'cccccccc-0000-0000-0000-000000000003';
const LIABILITY = 'gl-loan-liability';
const CURRENT_PORTION = 'gl-current-portion';

const JAN_ST = 120_000;
const FEB_ST = 118_000;

interface CapturedLine { glAccountId: string; debit: number; credit: number }

function loanRow(
  stLiability: number,
  closing: number,
  date: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: LOAN,
    company_id: COMPANY,
    reference: 'LN-001',
    status: 'active',
    gl_account_id: LIABILITY,
    interest_expense_account_id: 'gl-interest-expense',
    interest_payable_account_id: 'gl-interest-payable',
    bank_account_id: 'gl-bank',
    current_portion_account_id: CURRENT_PORTION,
    snapshot_closing: String(closing),
    snapshot_stliability: String(stLiability),
    snapshot_date: date,
    ...overrides,
  };
}

/**
 * Route the lock check to "not locked", the loan sweep to the given row, and
 * loan_reclass_postings to whatever the previous close recorded. `prior` of
 * null means no reclass was ever posted for this loan, which is the H2 case a
 * period lock cannot express.
 */
function primeMonth(row: Record<string, unknown>, prior: number | null = null): void {
  sqlMock.mockImplementation((strings: TemplateStringsArray) => {
    const q = strings.join('?');
    if (q.includes('FROM loan_reclass_postings')) {
      return Promise.resolve(
        prior == null ? [] : [{ loan_id: LOAN, st_liability: String(prior) }],
      );
    }
    if (q.includes('INSERT INTO loan_reclass_postings')) return Promise.resolve([]);
    if (q.includes('FROM loans l')) return Promise.resolve([row]);
    if (q.includes('FROM loan_period_locks')) return Promise.resolve([]);
    return Promise.resolve([]);
  });
}

function capturedLines(): CapturedLine[] {
  return createJournalEntryMock.mock.calls.flatMap(
    (c) => ((c[1] as { lines: CapturedLine[] }).lines ?? []),
  );
}

/** Net credit standing in the current-portion account after every close so far. */
function currentPortionBalance(): number {
  return capturedLines()
    .filter((l) => l.glAccountId === CURRENT_PORTION)
    .reduce((sum, l) => sum + l.credit - l.debit, 0);
}

beforeEach(() => {
  vi.clearAllMocks();
  let seq = 0;
  createJournalEntryMock.mockImplementation(() => Promise.resolve({ id: `je-${++seq}` }));
  postJournalEntryMock.mockResolvedValue(undefined);
});

describe('closeLoanPeriod — closing a second month', () => {
  it('leaves the current portion at February\'s figure, not January plus February', async () => {
    primeMonth(loanRow(JAN_ST, 900_000, '2025-01-31'));
    await closeLoanPeriod(COMPANY, '202501', USER);

    primeMonth(loanRow(FEB_ST, 890_000, '2025-02-28'), JAN_ST);
    await closeLoanPeriod(COMPANY, '202502', USER);

    expect(currentPortionBalance()).toBeCloseTo(FEB_ST, 2);
  });

  it('posts only the movement in the second month', async () => {
    primeMonth(loanRow(JAN_ST, 900_000, '2025-01-31'));
    await closeLoanPeriod(COMPANY, '202501', USER);
    const afterJan = capturedLines().length;

    primeMonth(loanRow(FEB_ST, 890_000, '2025-02-28'), JAN_ST);
    await closeLoanPeriod(COMPANY, '202502', USER);

    const febLines = capturedLines().slice(afterJan);
    const febGross = febLines.reduce((s, l) => s + l.credit + l.debit, 0);
    // The movement is 2,000 across two legs, not another 118,000 across two.
    expect(febGross).toBeCloseTo(Math.abs(JAN_ST - FEB_ST) * 2, 2);
  });

  it('still reclassifies the full amount on the first close', async () => {
    primeMonth(loanRow(JAN_ST, 900_000, '2025-01-31'));
    await closeLoanPeriod(COMPANY, '202501', USER);

    expect(currentPortionBalance()).toBeCloseTo(JAN_ST, 2);
  });

  it('posts nothing when the current portion is unchanged', async () => {
    primeMonth(loanRow(JAN_ST, 900_000, '2025-01-31'));
    await closeLoanPeriod(COMPANY, '202501', USER);
    const afterJan = createJournalEntryMock.mock.calls.length;

    primeMonth(loanRow(JAN_ST, 890_000, '2025-02-28'), JAN_ST);
    const result = await closeLoanPeriod(COMPANY, '202502', USER);

    expect(createJournalEntryMock.mock.calls.length).toBe(afterJan);
    expect(result.reclassEntries).toHaveLength(0);
  });

  it('reverses the movement when the current portion falls', async () => {
    primeMonth(loanRow(JAN_ST, 900_000, '2025-01-31'));
    await closeLoanPeriod(COMPANY, '202501', USER);
    const afterJan = capturedLines().length;

    // February's twelve-month window is smaller than January's.
    primeMonth(loanRow(FEB_ST, 890_000, '2025-02-28'), JAN_ST);
    await closeLoanPeriod(COMPANY, '202502', USER);

    const febLines = capturedLines().slice(afterJan);
    const currentPortionLeg = febLines.find((l) => l.glAccountId === CURRENT_PORTION)!;
    expect(currentPortionLeg.debit).toBeCloseTo(JAN_ST - FEB_ST, 2);
    expect(currentPortionLeg.credit).toBe(0);
    // Both legs still balance.
    expect(febLines.reduce((s, l) => s + l.debit, 0)).toBeCloseTo(
      febLines.reduce((s, l) => s + l.credit, 0), 2,
    );
    expect(currentPortionBalance()).toBeCloseTo(FEB_ST, 2);
  });
});

describe('closeLoanPeriod — a month that locked without reclassifying this loan', () => {
  // Review H2. closeLoanPeriod writes the period lock unconditionally, after
  // the `missing GL accounts`, `no schedule row` and zero-movement skips. The
  // prior figure used to be read off any earlier lock, so a close that posted
  // nothing for this loan still supplied a prior and the next close journalled
  // a movement off a balance that was never there — driving the current-portion
  // account to a DEBIT balance that never self-corrects.
  it('reclassifies the full amount when the earlier close skipped this loan', async () => {
    // January: the loan has no current-portion account, so the close skips it
    // and posts nothing — but still locks the month.
    primeMonth(loanRow(JAN_ST, 900_000, '2025-01-31', { current_portion_account_id: null }));
    const jan = await closeLoanPeriod(COMPANY, '202501', USER);
    expect(jan.reclassEntries).toHaveLength(0);
    expect(jan.skippedLoans).toEqual([{ loanId: LOAN, reason: 'missing GL accounts' }]);

    // February: accounts are fixed. Nothing was reclassified in January, so
    // February must post the FULL current portion, not a movement off it.
    primeMonth(loanRow(FEB_ST, 890_000, '2025-02-28'));
    await closeLoanPeriod(COMPANY, '202502', USER);

    expect(currentPortionBalance()).toBeCloseTo(FEB_ST, 2);
    const leg = capturedLines().find((l) => l.glAccountId === CURRENT_PORTION)!;
    expect(leg.credit).toBeCloseTo(FEB_ST, 2);
    expect(leg.debit).toBe(0);
  });

  it('records what it reclassified, so the next close reads a real figure', async () => {
    primeMonth(loanRow(JAN_ST, 900_000, '2025-01-31'));
    await closeLoanPeriod(COMPANY, '202501', USER);

    const recorded = sqlMock.mock.calls
      .map((c) => (c[0] as TemplateStringsArray).join('?'))
      .filter((q) => q.includes('INSERT INTO loan_reclass_postings'));
    expect(recorded).toHaveLength(1);
    // company_id, loan_id, yyyymm, st_liability, journal_entry_id
    const args = sqlMock.mock.calls.find(
      (c) => (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO loan_reclass_postings'),
    )!.slice(1);
    expect(args).toEqual([COMPANY, LOAN, '202501', JAN_ST, 'je-1']);
  });

  it('records nothing when the movement was zero and no journal posted', async () => {
    primeMonth(loanRow(JAN_ST, 900_000, '2025-01-31'), JAN_ST);
    await closeLoanPeriod(COMPANY, '202501', USER);

    const recorded = sqlMock.mock.calls
      .map((c) => (c[0] as TemplateStringsArray).join('?'))
      .filter((q) => q.includes('INSERT INTO loan_reclass_postings'));
    expect(recorded).toHaveLength(0);
  });
});
