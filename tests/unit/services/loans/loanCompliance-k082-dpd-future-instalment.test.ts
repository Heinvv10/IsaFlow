/**
 * K-082 RED — days past due is measured against an instalment that is not yet due.
 *
 * assessLoan picks the reference date as
 *   schedule.find((r) => !r.skip && r.date >= asOfDate)
 * — the NEXT instalment, on or after the assessment date. computeDaysPastDue is
 * then handed a due date that is by construction in the future, so its
 * `asOf <= scheduled` guard returns 0 every time. determineEclStage(0) is
 * stage 1, so every exposure is stage 1 and every loss allowance is the 12-month
 * ECL, no matter how long the borrower has been in arrears.
 *
 * Arrears live in the opposite direction: the reference date must be the OLDEST
 * instalment that fell due on or before the assessment date and has not been
 * settled, and the count runs from that date to the assessment date.
 *
 * The loan below has missed four consecutive monthly instalments and its last
 * payment cleared in January 2025. Assessed at 30 June 2025 it is roughly 120
 * days past due and stage 3.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock } = vi.hoisted(() => ({ sqlMock: vi.fn() }));

vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { assessLoan, computeDaysPastDue } from '@/modules/accounting/services/loans/loanComplianceService';

const COMPANY = 'aaaaaaaa-0000-0000-0000-000000000001';
const LOAN = 'bbbbbbbb-0000-0000-0000-000000000002';
const USER = 'cccccccc-0000-0000-0000-000000000003';
const AS_OF = '2025-06-30';

/** Monthly instalments; the last cash that actually arrived was January's. */
const SCHEDULE_DATES = [
  '2024-12-31', '2025-01-31', '2025-02-28', '2025-03-31',
  '2025-04-30', '2025-05-31', '2025-07-31', '2025-08-31',
];

function scheduleRows(): Record<string, unknown>[] {
  return SCHEDULE_DATES.map((date, i) => ({
    period: i + 1,
    date,
    opening: 500_000 - i * 5_000,
    rate: 0.11,
    installment: 10_000,
    interest: 4_500,
    principal: 5_500,
    skip_flag: false,
    payment: 10_000,
    lump: 0,
    closing: 500_000 - (i + 1) * 5_000,
    st_liability: 60_000,
    extrapolated: false,
    nca_flagged: false,
  }));
}

let inserted: Record<string, unknown> | null = null;

/**
 * Route every query assessLoan issues.
 *
 * `paidPeriods` seeds loan_payments — the receipt subledger and the only
 * evidence of settlement. loan_gl_postings is deliberately NOT a payment
 * source: postPeriodJournals writes the contractual instalment journal whether
 * or not cash arrived, so reading arrears from it makes a company that posts on
 * time look current while the borrower pays nothing.
 */
function primeSql(
  paidPeriods: number[],
  lastPaymentDate: string | null,
  rows: Record<string, unknown>[] = scheduleRows(),
): void {
  sqlMock.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join('?');
    if (q.includes('FROM loans')) return Promise.resolve([{ id: LOAN, company_id: COMPANY }]);
    if (q.includes('FROM loan_schedule_runs')) return Promise.resolve([{ id: 'run-1' }]);
    if (q.includes('FROM loan_schedule_rows')) return Promise.resolve(rows);
    if (q.includes('FROM loan_payments')) {
      return Promise.resolve(
        paidPeriods.map((period_number) => ({ period_number, payment_date: lastPaymentDate })),
      );
    }
    if (q.includes('INSERT INTO loan_compliance_assessments')) {
      // Values land positionally; days_past_due and ifrs9_stage are what matter.
      inserted = { ifrs9_stage: values[5], days_past_due: values[6], notes: values[11] };
      return Promise.resolve([{
        loan_id: LOAN, assessment_date: AS_OF, nca_flagged: false, nca_period: null,
        ifrs9_stage: values[5], days_past_due: values[6], ecl_amount: values[7],
        ecl_method: values[8], outstanding: values[9], notes: values[11],
        assessed_by: USER, assessed_at: AS_OF,
      }]);
    }
    return Promise.resolve([]);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  inserted = null;
  // Instalments 1 and 2 were paid; the last cash arrived on 31 January 2025.
  primeSql([1, 2], '2025-01-31');
});

describe('computeDaysPastDue — the reference date it is given', () => {
  it('counts the days since the oldest unsettled instalment fell due', () => {
    expect(computeDaysPastDue(null, AS_OF, '2025-02-28')).toBe(122);
  });

  it('reports nothing past due when the reference date is still ahead', () => {
    expect(computeDaysPastDue(null, AS_OF, '2025-07-31')).toBe(0);
  });
});

describe('assessLoan — a borrower four instalments in arrears', () => {
  it('records days past due, not zero', async () => {
    const assessment = await assessLoan(COMPANY, LOAN, USER, AS_OF);
    expect(assessment.daysPastDue).toBe(122);
  });

  it('moves the exposure to stage 3', async () => {
    const assessment = await assessLoan(COMPANY, LOAN, USER, AS_OF);
    expect(assessment.stage).toBe(3);
  });

  it('persists the same days past due it reports', async () => {
    await assessLoan(COMPANY, LOAN, USER, AS_OF);
    expect(Number(inserted!.days_past_due)).toBeGreaterThan(90);
  });

  it('leaves a loan paid up to date at stage 1', async () => {
    // Every instalment due on or before the assessment date has a receipt.
    primeSql([1, 2, 3, 4, 5, 6], AS_OF);
    const assessment = await assessLoan(COMPANY, LOAN, USER, AS_OF);
    expect(assessment.stage).toBe(1);
    expect(assessment.daysPastDue).toBe(0);
  });

  it('ignores skipped instalments when picking the oldest arrear', async () => {
    // February is a contractual payment holiday; March is the oldest real arrear.
    primeSql(
      [1, 2], '2025-01-31',
      scheduleRows().map((r) => (r.date === '2025-02-28' ? { ...r, skip_flag: true } : r)),
    );
    const assessment = await assessLoan(COMPANY, LOAN, USER, AS_OF);
    // 31 March to 30 June 2025 is 91 days, not February's 122.
    expect(assessment.daysPastDue).toBe(91);
  });

  it('counts from the oldest instalment when no receipt was ever recorded', async () => {
    primeSql([], null);
    const assessment = await assessLoan(COMPANY, LOAN, USER, AS_OF);
    // 31 December 2024 to 30 June 2025 is 181 days.
    expect(assessment.daysPastDue).toBe(181);
    expect(assessment.stage).toBe(3);
  });

  it('says so when it measured arrears with no receipts recorded at all', async () => {
    primeSql([], null);
    await assessLoan(COMPANY, LOAN, USER, AS_OF);
    expect(String(inserted!.notes)).toMatch(/No loan_payments receipts recorded/);
  });

  it('records no such note once receipts exist', async () => {
    await assessLoan(COMPANY, LOAN, USER, AS_OF);
    expect(inserted!.notes).toBeNull();
  });

  it('does not treat a posted period journal as a payment', async () => {
    // Review H1: the company posts its period journals on time and the
    // borrower pays nothing. Reading loan_gl_postings would call this current.
    primeSql([], null);
    await assessLoan(COMPANY, LOAN, USER, AS_OF);

    const queries = sqlMock.mock.calls.map((c) => (c[0] as TemplateStringsArray).join('?'));
    expect(queries.some((q) => q.includes('FROM loan_payments'))).toBe(true);
    expect(queries.some((q) => q.includes('MAX(posting_date)'))).toBe(false);
    expect(Number(inserted!.days_past_due)).toBe(181);
  });
});
