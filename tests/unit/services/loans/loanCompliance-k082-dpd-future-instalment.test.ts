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

beforeEach(() => {
  vi.clearAllMocks();
  inserted = null;
  sqlMock.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join('?');
    if (q.includes('FROM loans')) return Promise.resolve([{ id: LOAN, company_id: COMPANY }]);
    if (q.includes('FROM loan_schedule_runs')) return Promise.resolve([{ id: 'run-1' }]);
    if (q.includes('FROM loan_schedule_rows')) return Promise.resolve(scheduleRows());
    if (q.includes('MAX(posting_date)')) {
      return Promise.resolve([{ last_payment_date: '2025-01-31' }]);
    }
    if (q.includes('INSERT INTO loan_compliance_assessments')) {
      // Values land positionally; days_past_due and ifrs9_stage are what matter.
      inserted = { ifrs9_stage: values[5], days_past_due: values[6] };
      return Promise.resolve([{
        loan_id: LOAN, assessment_date: AS_OF, nca_flagged: false, nca_period: null,
        ifrs9_stage: values[5], days_past_due: values[6], ecl_amount: values[7],
        ecl_method: values[8], outstanding: values[9], notes: null,
        assessed_by: USER, assessed_at: AS_OF,
      }]);
    }
    return Promise.resolve([]);
  });
});

describe('computeDaysPastDue — the reference date it is given', () => {
  it('counts the days since the oldest unsettled instalment fell due', () => {
    // 28 February to 30 June 2025 is 122 days.
    expect(computeDaysPastDue(null, AS_OF, '2025-02-28')).toBe(122);
  });

  it('reports nothing past due when the reference date is still ahead', () => {
    expect(computeDaysPastDue(null, AS_OF, '2025-07-31')).toBe(0);
  });
});

describe('assessLoan — a borrower four instalments in arrears', () => {
  it('records days past due, not zero', async () => {
    const assessment = await assessLoan(COMPANY, LOAN, USER, AS_OF);
    expect(assessment.daysPastDue).toBeGreaterThan(90);
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
    sqlMock.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      const q = strings.join('?');
      if (q.includes('FROM loans')) return Promise.resolve([{ id: LOAN, company_id: COMPANY }]);
      if (q.includes('FROM loan_schedule_runs')) return Promise.resolve([{ id: 'run-1' }]);
      if (q.includes('FROM loan_schedule_rows')) return Promise.resolve(scheduleRows());
      if (q.includes('MAX(posting_date)')) return Promise.resolve([{ last_payment_date: AS_OF }]);
      if (q.includes('INSERT INTO loan_compliance_assessments')) {
        return Promise.resolve([{
          loan_id: LOAN, assessment_date: AS_OF, nca_flagged: false, nca_period: null,
          ifrs9_stage: values[5], days_past_due: values[6], ecl_amount: values[7],
          ecl_method: values[8], outstanding: values[9], notes: null,
          assessed_by: USER, assessed_at: AS_OF,
        }]);
      }
      return Promise.resolve([]);
    });

    const assessment = await assessLoan(COMPANY, LOAN, USER, AS_OF);
    expect(assessment.stage).toBe(1);
  });

  it('ignores skipped instalments when picking the oldest arrear', async () => {
    // February is a contractual payment holiday; March is the oldest real arrear.
    sqlMock.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      const q = strings.join('?');
      if (q.includes('FROM loans')) return Promise.resolve([{ id: LOAN, company_id: COMPANY }]);
      if (q.includes('FROM loan_schedule_runs')) return Promise.resolve([{ id: 'run-1' }]);
      if (q.includes('FROM loan_schedule_rows')) {
        return Promise.resolve(
          scheduleRows().map((r) => (r.date === '2025-02-28' ? { ...r, skip_flag: true } : r)),
        );
      }
      if (q.includes('MAX(posting_date)')) return Promise.resolve([{ last_payment_date: '2025-01-31' }]);
      if (q.includes('INSERT INTO loan_compliance_assessments')) {
        return Promise.resolve([{
          loan_id: LOAN, assessment_date: AS_OF, nca_flagged: false, nca_period: null,
          ifrs9_stage: values[5], days_past_due: values[6], ecl_amount: values[7],
          ecl_method: values[8], outstanding: values[9], notes: null,
          assessed_by: USER, assessed_at: AS_OF,
        }]);
      }
      return Promise.resolve([]);
    });

    const assessment = await assessLoan(COMPANY, LOAN, USER, AS_OF);
    // 31 March to 30 June 2025 is 91 days, not February's 122.
    expect(assessment.daysPastDue).toBe(91);
  });

  it('counts from the oldest instalment when no payment has ever posted', async () => {
    sqlMock.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      const q = strings.join('?');
      if (q.includes('FROM loans')) return Promise.resolve([{ id: LOAN, company_id: COMPANY }]);
      if (q.includes('FROM loan_schedule_runs')) return Promise.resolve([{ id: 'run-1' }]);
      if (q.includes('FROM loan_schedule_rows')) return Promise.resolve(scheduleRows());
      if (q.includes('MAX(posting_date)')) return Promise.resolve([{ last_payment_date: null }]);
      if (q.includes('INSERT INTO loan_compliance_assessments')) {
        return Promise.resolve([{
          loan_id: LOAN, assessment_date: AS_OF, nca_flagged: false, nca_period: null,
          ifrs9_stage: values[5], days_past_due: values[6], ecl_amount: values[7],
          ecl_method: values[8], outstanding: values[9], notes: null,
          assessed_by: USER, assessed_at: AS_OF,
        }]);
      }
      return Promise.resolve([]);
    });

    const assessment = await assessLoan(COMPANY, LOAN, USER, AS_OF);
    // 31 December 2024 to 30 June 2025 is 181 days.
    expect(assessment.daysPastDue).toBe(181);
    expect(assessment.stage).toBe(3);
  });
});
