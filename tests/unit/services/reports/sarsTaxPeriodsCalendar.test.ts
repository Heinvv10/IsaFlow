/**
 * SARS VAT calendar pinned against the published SARS categories.
 *   Category A ('odd')  — bi-monthly periods END Jan/Mar/May/Jul/Sep/Nov
 *   Category B ('even') — bi-monthly periods END Feb/Apr/Jun/Aug/Oct/Dec
 *   Category C          — monthly
 * VAT201 is due on the 25th of the month after the period ends, moved back to
 * the previous business day when the 25th is a weekend or a public holiday.
 * sarsTaxPeriodsService must agree with vatPeriodHelper (the single source).
 */
import { describe, it, expect } from 'vitest';
import { getTaxPeriods, getComplianceCalendar } from '@/modules/accounting/services/reports/sarsTaxPeriodsService';
import { vatQuickPeriods, type VatAlignment, type VatSetting } from '@/modules/bureau/services/vatPeriodHelper';

const vatOf = (year: number, alignment: VatAlignment, setting?: VatSetting) =>
  getTaxPeriods(year, alignment, setting).filter((p) => p.type === 'VAT');
const endMonth = (iso: string) => Number(iso.slice(5, 7));
const vat201Dues = (events: ReturnType<typeof getComplianceCalendar>) =>
  events.filter((e) => e.eventType === 'VAT201_DUE').map((e) => e.dueDate);

describe('getTaxPeriods — SARS VAT categories', () => {
  it('Category A (odd) periods end in Jan/Mar/May/Jul/Sep/Nov', () => {
    const vat = vatOf(2026, 'odd');
    expect(vat.map((p) => endMonth(p.periodEnd))).toEqual([1, 3, 5, 7, 9, 11]);
  });

  it('Category A crosses the year boundary: Dec 2025 – Jan 2026, due 25 Feb 2026', () => {
    const first = vatOf(2026, 'odd')[0]!;
    expect(first).toMatchObject({ periodStart: '2025-12-01', periodEnd: '2026-01-31', dueDate: '2026-02-25' });
    expect(vatOf(2026, 'odd')[5]).toMatchObject({ periodStart: '2026-10-01', periodEnd: '2026-11-30', dueDate: '2026-12-24' });
    expect(vatOf(2027, 'odd')[0]).toMatchObject({ periodStart: '2026-12-01', periodEnd: '2027-01-31', dueDate: '2027-02-25' });
  });

  it('Category B (even) periods end in Feb/Apr/Jun/Aug/Oct/Dec', () => {
    const vat = vatOf(2026, 'even');
    expect(vat.map((p) => endMonth(p.periodEnd))).toEqual([2, 4, 6, 8, 10, 12]);
  });

  it('Category B Jan–Feb is the first period; Nov–Dec is due 25 Jan of the next year', () => {
    const vat = vatOf(2026, 'even');
    expect(vat[0]).toMatchObject({ periodStart: '2026-01-01', periodEnd: '2026-02-28', dueDate: '2026-03-25' });
    expect(vat[5]).toMatchObject({ periodStart: '2026-11-01', periodEnd: '2026-12-31', dueDate: '2027-01-25' });
  });

  it('Category B Jan–Feb ends on 29 Feb in a leap year', () => {
    expect(vatOf(2028, 'even')[0]!.periodEnd).toBe('2028-02-29');
  });

  it('Category C (monthly) has twelve one-month periods, Dec due 25 Jan next year', () => {
    const vat = vatOf(2026, 'odd', 'monthly');
    expect(vat).toHaveLength(12);
    expect(vat.map((p) => endMonth(p.periodEnd))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(vat.every((p) => p.periodStart.slice(0, 7) === p.periodEnd.slice(0, 7))).toBe(true);
    expect(vat[11]).toMatchObject({ periodStart: '2026-12-01', periodEnd: '2026-12-31', dueDate: '2027-01-25' });
  });

  it('a non-vendor has no VAT periods but keeps its PAYE periods', () => {
    const all = getTaxPeriods(2026, 'odd', 'none');
    expect(all.filter((p) => p.type === 'VAT')).toHaveLength(0);
    expect(all.filter((p) => p.type === 'PAYE')).toHaveLength(12);
  });

  it.each(['odd', 'even'] as const)('agrees with vatPeriodHelper.vatQuickPeriods for %s alignment', (a) => {
    const helper = vatQuickPeriods(2026, 'bi-monthly', a).map((q) => [q.from, q.to]);
    expect(vatOf(2026, a).map((p) => [p.periodStart, p.periodEnd])).toEqual(helper);
  });
});

describe('getComplianceCalendar — VAT201 due dates', () => {
  it('Category A: due 25 Feb/Apr/Jun/Aug/Oct/Dec (weekend and holiday 25ths moved back; Christmas -> 24 Dec)', () => {
    expect(vat201Dues(getComplianceCalendar(2026, 'odd'))).toEqual([
      '2026-02-25', '2026-04-24', '2026-06-25', '2026-08-25', '2026-10-23', '2026-12-24',
    ]);
  });

  it('Category B: due 25 Mar/May/Jul/Sep/Nov and 25 Jan next year (weekend and holiday 25ths moved back)', () => {
    expect(vat201Dues(getComplianceCalendar(2026, 'even'))).toEqual([
      '2026-03-25', '2026-05-25', '2026-07-24', '2026-09-25', '2026-11-25', '2027-01-25',
    ]);
  });

  it('Category C: twelve VAT201 events, one per month', () => {
    const dues = vat201Dues(getComplianceCalendar(2026, 'odd', 'monthly'));
    expect(dues).toHaveLength(12);
    expect(dues[0]).toBe('2026-02-25');
    expect(dues[11]).toBe('2027-01-25');
  });

  it('a non-vendor gets no VAT201 events', () => {
    const events = getComplianceCalendar(2026, 'odd', 'none');
    expect(vat201Dues(events)).toHaveLength(0);
    expect(events.some((e) => e.eventType === 'EMP201_DUE')).toBe(true);
  });

  it('labels the Category A year-boundary period Dec–Jan 2025/2026', () => {
    const first = getComplianceCalendar(2026, 'odd').find((e) => e.eventType === 'VAT201_DUE')!;
    expect(first.description).toBe('VAT201 return for Dec–Jan 2025/2026');
  });
});

describe('VAT201 due date — weekend shift', () => {
  const dueFor = (periodEnd: string, alignment: VatAlignment, year: number) =>
    vatOf(year, alignment).find((p) => p.periodEnd === periodEnd)!.dueDate;

  it('a Saturday 25th moves back to Friday the 24th (Cat A Feb–Mar 2026, 25 Apr 2026 is a Saturday)', () => {
    expect(dueFor('2026-03-31', 'odd', 2026)).toBe('2026-04-24');
  });

  it('a Sunday 25th moves back to Friday the 23rd (Cat A Aug–Sep 2026, 25 Oct 2026 is a Sunday)', () => {
    expect(dueFor('2026-09-30', 'odd', 2026)).toBe('2026-10-23');
  });

  it('a Sunday 25th across the year boundary moves back too (Cat B Nov–Dec 2025, 25 Jan 2026 is a Sunday)', () => {
    expect(dueFor('2025-12-31', 'even', 2025)).toBe('2026-01-23');
  });

  it('a public holiday on a weekday moves back too: 25 Dec 2026 (Christmas, Friday) -> Thursday 24 Dec', () => {
    expect(dueFor('2026-11-30', 'odd', 2026)).toBe('2026-12-24');
  });

  it('a weekday 25th is unchanged', () => {
    expect(dueFor('2026-01-31', 'odd', 2026)).toBe('2026-02-25');
  });
});
