/**
 * Non-VAT deadlines in the SARS compliance calendar:
 *   EMP201 — the 7th of the following month;
 *   EMP501 — ANNUAL reconciliation due 31 May, INTERIM (Mar–Aug) due 31 Oct;
 *   IRP6   — 1st payment 31 Aug, 2nd payment the last day of February (leap-aware).
 * An EMP201 / EMP501 / IRP6 due date on a Saturday or Sunday moves back to the
 * Friday (TAA s244; no holiday calendar).
 */
import { describe, it, expect } from 'vitest';
import { getComplianceCalendar, getTaxPeriods } from '@/modules/accounting/services/reports/sarsTaxPeriodsService';

const ofType = (year: number, type: string) => getComplianceCalendar(year, 'odd').filter((e) => e.eventType === type);

describe('EMP501 reconciliation labels', () => {
  it('31 May is the ANNUAL reconciliation for the tax year ending Feb of that year', () => {
    const may = ofType(2027, 'EMP501_DUE').find((e) => e.dueDate === '2027-05-31')!;
    expect(may.description).toMatch(/Annual/);
    expect(may.description).toContain('Tax Year ending Feb 2027');
  });

  it('31 Oct is the INTERIM (Mar–Aug) reconciliation for the tax year ending Feb of the next year', () => {
    const oct = ofType(2025, 'EMP501_DUE').find((e) => e.dueDate === '2025-10-31')!;
    expect(oct.description).toMatch(/Interim/);
    expect(oct.description).toContain('Mar–Aug 2025');
    expect(oct.description).toContain('Tax Year ending Feb 2026');
  });
});

describe('IRP6 provisional tax dates', () => {
  it('2nd payment is 29 Feb in a leap year (2028-02-29 is a Tuesday)', () => {
    expect(ofType(2027, 'PROVISIONAL_TAX').map((e) => e.dueDate)).toEqual(['2027-08-31', '2028-02-29']);
  });

  it('2nd payment on a Sunday 28 Feb moves back to Friday 26 Feb (2027)', () => {
    expect(ofType(2026, 'PROVISIONAL_TAX').map((e) => e.dueDate)).toEqual(['2026-08-31', '2027-02-26']);
  });

  it('1st payment on a Sunday 31 Aug moves back to Friday 29 Aug (2025)', () => {
    expect(ofType(2025, 'PROVISIONAL_TAX')[0]!.dueDate).toBe('2025-08-29');
  });
});

describe('EMP201 weekend shift', () => {
  it('a Saturday 7th moves back to Friday the 6th (7 Feb 2026)', () => {
    expect(ofType(2026, 'EMP201_DUE').find((e) => e.description.includes('January 2026'))!.dueDate).toBe('2026-02-06');
  });

  it('a Sunday 7th moves back to Friday the 5th (7 Jun 2026)', () => {
    expect(ofType(2026, 'EMP201_DUE').find((e) => e.description.includes('May 2026'))!.dueDate).toBe('2026-06-05');
  });

  it('a weekday 7th is unchanged (7 Apr 2026 is a Tuesday)', () => {
    expect(ofType(2026, 'EMP201_DUE').find((e) => e.description.includes('March 2026'))!.dueDate).toBe('2026-04-07');
  });

  it('getTaxPeriods PAYE due dates follow the same rule', () => {
    const paye = getTaxPeriods(2026, 'odd').filter((p) => p.type === 'PAYE');
    expect(paye[0]!.dueDate).toBe('2026-02-06');
    expect(paye[4]!.dueDate).toBe('2026-06-05');
    expect(paye[2]!.dueDate).toBe('2026-04-07');
  });
});

describe('EMP501 weekend shift', () => {
  it('annual due Sunday 31 May 2026 moves back to Friday 29 May', () => {
    expect(ofType(2026, 'EMP501_DUE').find((e) => /Annual/.test(e.description))!.dueDate).toBe('2026-05-29');
  });

  it('interim due Saturday 31 Oct 2026 moves back to Friday 30 Oct', () => {
    expect(ofType(2026, 'EMP501_DUE').find((e) => /Interim/.test(e.description))!.dueDate).toBe('2026-10-30');
  });
});
