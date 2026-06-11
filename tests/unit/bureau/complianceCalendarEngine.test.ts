// RED phase — written before implementation
/**
 * Pure date-math tests for the compliance calendar engine.
 *
 * Conventions under test (documented in the engine):
 * - Window is [today - graceDays, today + horizonDays] on calendar dates
 *   (UTC): items due today stay visible, and a missed deadline lingers as
 *   overdue for the grace period (default 7 days).
 * - VAT due the 25th of the month after period end (same rule as
 *   vatPeriodHelper). 'odd' alignment = periods END in odd months (Cat A
 *   in the cockpit's existing convention); 'even' = END in even months.
 *   Only periods ending AFTER today are emitted — the just-ended period is
 *   owned by vatDueSignal, which knows the filing status.
 * - EMP201 due the 7th of every month, for the prior month; pulled BACK to
 *   the Friday when the 7th is a weekend (SARS moves it earlier, not later).
 *   Public holidays are out of scope.
 * - EMP501 interim due 31 Oct, annual due 31 May.
 * - IRP6: 1st payment last day of the 6th month before financial year end;
 *   2nd payment last day of the year-end month (leap-aware).
 * - CIPC annual return: last day of the anniversary month.
 * - No weekend adjustment for VAT/IRP6/EMP501/CIPC (the 25th eFiling rule
 *   extends later, and last-day rules are already the earliest-safe choice).
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

describe('upcomingObligations — EMP201 (monthly, 7th, weekend pulled back)', () => {
  it('emits each month in the window, including the recent-overdue grace item', () => {
    const items = upcomingObligations(cfg({ emp201Enabled: true }), JUN_11);
    // 7 Jun 2026 is a Sunday → May's EMP201 pulls back to Fri 5 Jun, which is
    // within the 7-day overdue grace as of 11 Jun.
    expect(dues(items, 'emp201')).toEqual(['2026-06-05', '2026-07-07', '2026-08-07', '2026-09-07']);
    expect(items[0]!.detail).toBe('May 2026');
    expect(items[0]!.task).toBe('EMP201 due');
    expect(items[1]!.detail).toBe('Jun 2026');
  });

  it('wraps across the year boundary and pulls a Sunday 7th back to Friday', () => {
    const dec1 = new Date(Date.UTC(2026, 11, 1)); // horizon → 2027-03-01
    const items = upcomingObligations(cfg({ emp201Enabled: true }), dec1);
    // 7 Feb 2027 is a Sunday → Fri 5 Feb 2027
    expect(dues(items, 'emp201')).toEqual(['2026-12-07', '2027-01-07', '2027-02-05']);
  });
});

describe('upcomingObligations — VAT cycle', () => {
  it('Category A (odd month-ends): emits only periods ending after today', () => {
    const items = upcomingObligations(
      cfg({ vat: { enabled: true, period: 'bi-monthly', alignment: 'odd' } }),
      JUN_11,
    );
    // period Apr–May ended 31 May → OWNED BY vatDueSignal (filing-aware), not
    // emitted here; period Jun–Jul ends 31 Jul → due 25 Aug
    expect(dues(items, 'vat')).toEqual(['2026-08-25']);
    expect(items.find((i) => i.dueDate === '2026-08-25')!.detail).toBe('Jun–Jul 2026');
  });

  it('labels the Dec–Jan year-wrap period with the end year', () => {
    const dec20 = new Date(Date.UTC(2026, 11, 20)); // horizon → 2027-03-20
    const items = upcomingObligations(
      cfg({ vat: { enabled: true, period: 'bi-monthly', alignment: 'odd' } }),
      dec20,
    );
    expect(dues(items, 'vat')).toEqual(['2027-02-25']);
    expect(items[0]!.detail).toBe('Dec–Jan 2027');
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

  it('monthly vendors get a due date for every month ending after today', () => {
    const items = upcomingObligations(
      cfg({ vat: { enabled: true, period: 'monthly', alignment: 'odd' } }),
      JUN_11,
    );
    // May ended 31 May → vatDueSignal's; Jun ends 30 Jun → 25 Jul; Jul → 25 Aug
    expect(dues(items, 'vat')).toEqual(['2026-07-25', '2026-08-25']);
    expect(items[0]!.detail).toBe('Jun 2026');
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

  it('Dec year-end: 1st payment due 30 Jun carries the SAME-year FY label', () => {
    const items = upcomingObligations(
      cfg({ provisionalTax: { enabled: true, yearEndMonth: 12 } }),
      JUN_11,
    );
    expect(dues(items, 'provisional_tax')).toEqual(['2026-06-30']);
    expect(items[0]!.detail).toBe('1st payment FY2026');
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
  it('includes a due date equal to today and one exactly at the horizon', () => {
    // EMP201 for Jun is due Tue 2026-07-07: viewed ON the due date it must
    // still be visible.
    const jul7 = new Date(Date.UTC(2026, 6, 7));
    const items = upcomingObligations(cfg({ emp201Enabled: true }), jul7);
    expect(dues(items, 'emp201')[0]).toBe('2026-07-07');

    // horizon of exactly 31 days from 2026-07-07 → 2026-08-07 included
    const tight = upcomingObligations(cfg({ emp201Enabled: true }), jul7, 31);
    expect(dues(tight, 'emp201')).toEqual(['2026-07-07', '2026-08-07']);
  });

  it('drops an overdue item once it is older than the grace period', () => {
    // EMP201 due 2026-07-07; on 2026-07-20 it is 13 days past — outside the
    // default 7-day grace, so it no longer appears.
    const jul20 = new Date(Date.UTC(2026, 6, 20));
    const items = upcomingObligations(cfg({ emp201Enabled: true }), jul20);
    expect(dues(items, 'emp201')[0]).toBe('2026-08-07');
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
