// RED phase — written before implementation
/**
 * Pure date-math tests for the compliance calendar engine.
 *
 * Conventions under test (documented in the engine):
 * - Window is (today, today + horizonDays] compared on calendar dates (UTC).
 * - VAT due the 25th of the month after period end (same rule as
 *   vatPeriodHelper). 'odd' alignment = periods END in odd months (Cat A
 *   in the cockpit's existing convention); 'even' = END in even months.
 * - EMP201 due the 7th of every month, for the prior month.
 * - EMP501 interim due 31 Oct, annual due 31 May.
 * - IRP6: 1st payment last day of the 6th month before financial year end;
 *   2nd payment last day of the year-end month (leap-aware).
 * - CIPC annual return: last day of the anniversary month.
 * - No weekend/holiday adjustment (deliberate, consistent with vatPeriodHelper).
 */

import { describe, it, expect } from 'vitest';
import {
  upcomingObligations,
  type EngineConfig,
} from '@/modules/bureau/services/complianceCalendarEngine';

const NONE: EngineConfig = {
  vat: { enabled: false, period: 'bi-monthly', alignment: 'odd' },
  emp201Enabled: false,
  emp501Enabled: false,
  provisionalTax: { enabled: false, yearEndMonth: 2 },
  cipc: { enabled: false, anniversaryMonth: null },
};

function cfg(overrides: Partial<EngineConfig>): EngineConfig {
  return { ...NONE, ...overrides };
}

const JUN_11 = new Date(Date.UTC(2026, 5, 11)); // 2026-06-11, horizon → 2026-09-09

function dues(items: ReturnType<typeof upcomingObligations>, kind?: string) {
  return items.filter((i) => !kind || i.kind === kind).map((i) => i.dueDate);
}

describe('upcomingObligations — disabled config', () => {
  it('returns nothing when no obligations are enabled', () => {
    expect(upcomingObligations(NONE, JUN_11)).toEqual([]);
  });
});

describe('upcomingObligations — EMP201 (monthly, 7th)', () => {
  it('emits the 7th of each month in the 90-day window, skipping past dates', () => {
    const items = upcomingObligations(cfg({ emp201Enabled: true }), JUN_11);
    expect(dues(items, 'emp201')).toEqual(['2026-07-07', '2026-08-07', '2026-09-07']);
    // the July item covers the June payroll month
    expect(items[0]!.detail).toBe('Jun 2026');
    expect(items[0]!.task).toBe('EMP201 due');
  });

  it('wraps across the year boundary', () => {
    const dec1 = new Date(Date.UTC(2026, 11, 1)); // horizon → 2027-03-01
    const items = upcomingObligations(cfg({ emp201Enabled: true }), dec1);
    expect(dues(items, 'emp201')).toEqual(['2026-12-07', '2027-01-07', '2027-02-07']);
  });
});

describe('upcomingObligations — VAT cycle', () => {
  it('Category A (odd month-ends): due 25th after each odd-month period end', () => {
    const items = upcomingObligations(
      cfg({ vat: { enabled: true, period: 'bi-monthly', alignment: 'odd' } }),
      JUN_11,
    );
    // period Apr–May ended 31 May → due 25 Jun; period Jun–Jul ends 31 Jul → due 25 Aug
    expect(dues(items, 'vat')).toEqual(['2026-06-25', '2026-08-25']);
    expect(items.find((i) => i.dueDate === '2026-06-25')!.detail).toBe('Apr–May 2026');
    expect(items.find((i) => i.dueDate === '2026-08-25')!.detail).toBe('Jun–Jul 2026');
  });

  it('Category B (even month-ends) is offset by one month', () => {
    const items = upcomingObligations(
      cfg({ vat: { enabled: true, period: 'bi-monthly', alignment: 'even' } }),
      JUN_11,
    );
    // period May–Jun ends 30 Jun → due 25 Jul (25 Sep falls outside the window)
    expect(dues(items, 'vat')).toEqual(['2026-07-25']);
    expect(items[0]!.detail).toBe('May–Jun 2026');
    expect(items[0]!.task).toBe('VAT return due');
  });

  it('monthly vendors get a due date every month', () => {
    const items = upcomingObligations(
      cfg({ vat: { enabled: true, period: 'monthly', alignment: 'odd' } }),
      JUN_11,
    );
    expect(dues(items, 'vat')).toEqual(['2026-06-25', '2026-07-25', '2026-08-25']);
    expect(items[0]!.detail).toBe('May 2026');
  });
});

describe('upcomingObligations — EMP501 seasons', () => {
  it('interim recon due 31 Oct', () => {
    const sep15 = new Date(Date.UTC(2026, 8, 15));
    const items = upcomingObligations(cfg({ emp501Enabled: true }), sep15);
    expect(dues(items, 'emp501')).toEqual(['2026-10-31']);
    expect(items[0]!.detail).toBe('Interim Mar–Aug 2026');
  });

  it('annual recon due 31 May', () => {
    const mar20 = new Date(Date.UTC(2026, 2, 20));
    const items = upcomingObligations(cfg({ emp501Enabled: true }), mar20);
    expect(dues(items, 'emp501')).toEqual(['2026-05-31']);
    expect(items[0]!.detail).toBe('Annual Mar 2025–Feb 2026');
  });
});

describe('upcomingObligations — provisional tax (IRP6)', () => {
  it('Feb year-end: 1st payment due 31 Aug', () => {
    const items = upcomingObligations(
      cfg({ provisionalTax: { enabled: true, yearEndMonth: 2 } }),
      JUN_11,
    );
    expect(dues(items, 'provisional_tax')).toEqual(['2026-08-31']);
    expect(items[0]!.detail).toBe('1st payment FY2027');
  });

  it('Feb year-end: 2nd payment lands on 29 Feb in a leap year', () => {
    const dec15 = new Date(Date.UTC(2027, 11, 15)); // horizon → 2028-03-14
    const items = upcomingObligations(
      cfg({ provisionalTax: { enabled: true, yearEndMonth: 2 } }),
      dec15,
    );
    expect(dues(items, 'provisional_tax')).toEqual(['2028-02-29']);
    expect(items[0]!.detail).toBe('2nd payment FY2028');
  });

  it('Jun year-end: 2nd payment due 30 Jun, 1st (31 Dec) outside the window', () => {
    const items = upcomingObligations(
      cfg({ provisionalTax: { enabled: true, yearEndMonth: 6 } }),
      JUN_11,
    );
    expect(dues(items, 'provisional_tax')).toEqual(['2026-06-30']);
    expect(items[0]!.detail).toBe('2nd payment FY2026');
  });
});

describe('upcomingObligations — CIPC annual return', () => {
  it('due the last day of the anniversary month', () => {
    const items = upcomingObligations(
      cfg({ cipc: { enabled: true, anniversaryMonth: 7 } }),
      JUN_11,
    );
    expect(dues(items, 'cipc_annual_return')).toEqual(['2026-07-31']);
    expect(items[0]!.task).toBe('CIPC annual return due');
  });

  it('emits nothing without an anniversary month', () => {
    const items = upcomingObligations(
      cfg({ cipc: { enabled: true, anniversaryMonth: null } }),
      JUN_11,
    );
    expect(items).toEqual([]);
  });
});

describe('upcomingObligations — window boundaries and ordering', () => {
  it('excludes a due date equal to today and includes one exactly at the horizon', () => {
    // EMP201 due 2026-06-07: today = due date → excluded.
    const jun7 = new Date(Date.UTC(2026, 5, 7));
    const items = upcomingObligations(cfg({ emp201Enabled: true }), jun7);
    expect(dues(items, 'emp201')[0]).toBe('2026-07-07');

    // horizon of exactly 30 days from 2026-06-07 → 2026-07-07 included
    const tight = upcomingObligations(cfg({ emp201Enabled: true }), jun7, 30);
    expect(dues(tight, 'emp201')).toEqual(['2026-07-07']);
  });

  it('returns all kinds sorted by due date', () => {
    const items = upcomingObligations(
      cfg({
        emp201Enabled: true,
        vat: { enabled: true, period: 'bi-monthly', alignment: 'odd' },
        provisionalTax: { enabled: true, yearEndMonth: 2 },
        cipc: { enabled: true, anniversaryMonth: 7 },
      }),
      JUN_11,
    );
    const sorted = [...items].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    expect(items.map((i) => i.dueDate)).toEqual(sorted.map((i) => i.dueDate));
    expect(new Set(items.map((i) => i.kind))).toEqual(
      new Set(['emp201', 'vat', 'provisional_tax', 'cipc_annual_return']),
    );
  });
});
