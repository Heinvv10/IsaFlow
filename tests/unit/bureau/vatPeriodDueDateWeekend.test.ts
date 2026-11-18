/**
 * ONE VAT201 due-date rule: the 25th of the month after the period ends,
 * moved back to the previous business day on a weekend or public holiday
 * (TAA s244). vatPeriodHelper owns it; the cockpit (bureauVatSignal), the
 * compliance engine and the SARS page calendar must all agree.
 */
import { describe, it, expect } from 'vitest';
import { previousBusinessDay, expectedVatPeriodAsOf, type VatAlignment, type VatCadence } from '@/modules/bureau/services/vatPeriodHelper';
import { shapeVatDue } from '@/modules/bureau/services/bureauVatSignal';
import type { CompanyMeta } from '@/modules/bureau/services/bureauWorkAggregatorService';
import { getComplianceCalendar } from '@/modules/accounting/services/reports/sarsTaxPeriodsService';

const utc = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe('previousBusinessDay (vatPeriodHelper)', () => {
  it('Saturday → Friday, Sunday → Friday, weekday unchanged', () => {
    expect(previousBusinessDay(2026, 4, 25)).toBe('2026-04-24');
    expect(previousBusinessDay(2026, 10, 25)).toBe('2026-10-23');
    expect(previousBusinessDay(2026, 6, 25)).toBe('2026-06-25');
  });
});

describe('expectedVatPeriodAsOf — weekend due date', () => {
  it('Cat A Aug–Sep 2026: Sunday 25 Oct → Friday 23 Oct', () => {
    expect(expectedVatPeriodAsOf('odd', utc('2026-10-24'))).toEqual({ periodStart: '2026-08-01', periodEnd: '2026-09-30', dueDate: '2026-10-23' });
  });

  it('Cat B May–Jun 2026: Saturday 25 Jul → Friday 24 Jul', () => {
    expect(expectedVatPeriodAsOf('even', utc('2026-07-01')).dueDate).toBe('2026-07-24');
  });
});

describe('bureauVatSignal — the cockpit VAT item', () => {
  const meta = new Map<string, CompanyMeta>([
    ['c1', { bureau_id: 'b1', bureau_name: 'Acme Books', company_id: 'c1', company_name: 'Client One' }],
  ]);

  it('Cat A on Sat 24 Oct 2026 with Aug–Sep unfiled: due 2026-10-23 and overdue', () => {
    const items = shapeVatDue([{ id: 'c1', vat_period_alignment: 'odd' }], [], meta, utc('2026-10-24'));
    expect(items[0]).toMatchObject({ detail: 'Aug–Sep 2026', dueAt: '2026-10-23', severity: 'overdue' });
  });
});

describe('vatPeriodHelper agrees with the SARS page calendar', () => {
  const cases: Array<[VatAlignment, VatCadence]> = [['odd', 'bi-monthly'], ['even', 'bi-monthly'], ['odd', 'monthly']];
  it.each(cases)('%s / %s: every period ending in 2026 has the same due date', (alignment, cadence) => {
    const sars = new Map(getComplianceCalendar(2026, alignment, cadence)
      .filter((e) => e.eventType === 'VAT201_DUE').map((e) => [e.description, e.dueDate]));
    const helperDues: string[] = [];
    for (let m = 1; m <= 12; m++) {
      const lastDay = new Date(Date.UTC(2026, m, 0)).toISOString().slice(0, 10);
      const p = expectedVatPeriodAsOf(alignment, utc(lastDay), cadence);
      if (p.periodEnd === lastDay) helperDues.push(p.dueDate);
    }
    expect(helperDues.length).toBe(sars.size);
    expect(helperDues).toEqual([...sars.values()]);
  });
});

describe('expectedVatPeriodAsOf — public-holiday due date', () => {
  it('Cat A Oct–Nov 2026: Friday 25 Dec (Christmas) -> Thursday 24 Dec', () => {
    expect(expectedVatPeriodAsOf('odd', utc('2026-12-01'))).toEqual({ periodStart: '2026-10-01', periodEnd: '2026-11-30', dueDate: '2026-12-24' });
  });
});
