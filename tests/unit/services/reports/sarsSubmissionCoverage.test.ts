/**
 * A calendar item is "Filed on eFiling" when IsaFlow's own filed submissions (sars_submissions
 * 'submitted' or 'accepted') of the same type, lying wholly inside the item's period, together
 * cover every day of it. A partial overlap, a submission reaching outside the period, another
 * type, or an unfiled status never completes it.
 */
import { describe, it, expect } from 'vitest';
import { coveringSubmissions, type FiledSubmission } from '@/modules/accounting/services/reports/sarsSubmissionCoverage';

const sub = (formType: string, periodStart: string, periodEnd: string, extra: Partial<FiledSubmission> = {}): FiledSubmission =>
  ({ formType, periodStart, periodEnd, reference: null, submittedAt: null, ...extra });
const VAT_JF = { eventType: 'VAT201_DUE', periodStart: '2026-01-01', periodEnd: '2026-02-28' };
const EMP_DEC = { eventType: 'EMP201_DUE', periodStart: '2025-12-01', periodEnd: '2025-12-31' };

describe('coveringSubmissions', () => {
  it('an EMP201 for exactly the month covers the item', () => {
    expect(coveringSubmissions(EMP_DEC, [sub('EMP201', '2025-12-01', '2025-12-31')])).toHaveLength(1);
  });

  it('a VAT201 for exactly the bi-monthly period covers it', () => {
    expect(coveringSubmissions(VAT_JF, [sub('VAT201', '2026-01-01', '2026-02-28')])).toHaveLength(1);
  });

  it('two monthly VAT201s together cover the bi-monthly period', () => {
    expect(coveringSubmissions(VAT_JF, [sub('VAT201', '2026-02-01', '2026-02-28'), sub('VAT201', '2026-01-01', '2026-01-31')])).toHaveLength(2);
  });

  it('one month of a two-month period does not (the Demo seed shape)', () => {
    expect(coveringSubmissions(VAT_JF, [sub('VAT201', '2026-02-01', '2026-02-28')])).toBeNull();
  });

  it('a gap of one day does not', () => {
    expect(coveringSubmissions(VAT_JF, [sub('VAT201', '2026-01-01', '2026-01-30'), sub('VAT201', '2026-02-01', '2026-02-28')])).toBeNull();
  });

  it('a submission reaching outside the period never counts (bi-monthly filing, monthly item)', () => {
    const febMonthly = { eventType: 'VAT201_DUE', periodStart: '2026-02-01', periodEnd: '2026-02-28' };
    expect(coveringSubmissions(febMonthly, [sub('VAT201', '2026-01-01', '2026-02-28')])).toBeNull();
  });

  it('another type never counts', () => {
    expect(coveringSubmissions(EMP_DEC, [sub('VAT201', '2025-12-01', '2025-12-31')])).toBeNull();
  });

  it('EMP501 and IRP6 items are never covered by a submission', () => {
    const irp6 = { eventType: 'PROVISIONAL_TAX', periodStart: '2026-03-01', periodEnd: '2026-08-31' };
    expect(coveringSubmissions(irp6, [sub('IRP6', '2026-03-01', '2026-08-31')])).toBeNull();
  });

  it('overlapping and duplicate submissions inside the period still cover it', () => {
    expect(coveringSubmissions(EMP_DEC, [sub('EMP201', '2025-12-01', '2025-12-31'), sub('EMP201', '2025-12-01', '2025-12-31')])).toHaveLength(2);
    expect(coveringSubmissions(VAT_JF, [sub('VAT201', '2026-01-01', '2026-02-10'), sub('VAT201', '2026-02-01', '2026-02-28')])).toHaveLength(2);
  });

  it('a leap February is covered to the 29th, not the 28th', () => {
    const febLeap = { eventType: 'EMP201_DUE', periodStart: '2028-02-01', periodEnd: '2028-02-29' };
    expect(coveringSubmissions(febLeap, [sub('EMP201', '2028-02-01', '2028-02-28')])).toBeNull();
    expect(coveringSubmissions(febLeap, [sub('EMP201', '2028-02-01', '2028-02-29')])).toHaveLength(1);
  });
});
