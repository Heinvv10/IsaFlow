/**
 * driverLine (P4 PR-3): a caller's driver line keeps exactly its kind's fields (the table's
 * per-kind CHECK), ids lower-cased, rounding R1 by default; the engine definition converts rand
 * to cents exactly and refuses what NUMERIC(15,2) cannot hold.
 */
import { describe, expect, it } from 'vitest';
import { normaliseLine, toDriverDef } from '@/modules/accounting/services/budgets/drivers/driverLine';
import { DriverRangeError, DriverRefError } from '@/modules/accounting/services/budgets/drivers/driverTypes';

const A = 'AAAAAAAA-0000-4000-8000-000000000001';
const R = 'bbbbbbbb-0000-4000-8000-000000000002';
const C = 'cccccccc-0000-4000-8000-000000000003';
const base = { glAccountId: A, cc1Id: null, cc2Id: null, buId: null, fromMonth: '2026-03', toMonth: '2026-05' };

describe('normaliseLine', () => {
  it("keeps only the kind's columns, lower-cases ids and defaults rounding to R1", () => {
    const line = normaliseLine({ ...base, kind: 'fixed', amount: 12.5, pct: 3, ref: { glAccountId: R, cc1Id: null, cc2Id: null, buId: null }, baseMonth: '2026-01' });
    expect(line).toEqual({
      glAccountId: A.toLowerCase(), cc1Id: null, cc2Id: null, buId: null, kind: 'fixed', fromMonth: '2026-03', toMonth: '2026-05',
      amount: 12.5, pct: null, ref: null, section: null, scope: null, baseMonth: null, headcountCostCentreId: null, rounding: 1,
    });
    const pct = normaliseLine({ ...base, cc1Id: C.toUpperCase(), kind: 'pct_of_line', pct: 38, amount: 9, ref: { glAccountId: R.toUpperCase(), cc1Id: null, cc2Id: null, buId: null }, rounding: 100 });
    expect(pct).toMatchObject({ cc1Id: C, amount: null, pct: 38, ref: { glAccountId: R }, rounding: 100 });
    expect(normaliseLine({ ...base, kind: 'per_head', amount: 1, headcountCostCentreId: C.toUpperCase() }).headcountCostCentreId).toBe(C);
  });

  it("refuses a kind without its own field (DriverRefError)", () => {
    expect(() => normaliseLine({ ...base, kind: 'fixed' })).toThrow(DriverRefError);
    expect(() => normaliseLine({ ...base, kind: 'pct_of_line', pct: 5 })).toThrow(/referenced row/);
    expect(() => normaliseLine({ ...base, kind: 'pct_of_section', pct: 5, section: 'turnover' })).toThrow(/scope/);
    expect(() => normaliseLine({ ...base, kind: 'growth', pct: 5 })).toThrow(/base month/);
  });
});

describe('toDriverDef', () => {
  it('converts rand to exact cents and ids to row keys', () => {
    expect(toDriverDef(normaliseLine({ ...base, kind: 'fixed', amount: 1234567.89 }))).toEqual({
      kind: 'fixed', rowKey: `${A.toLowerCase()}|||`, rounding: 1, fromMonth: '2026-03', toMonth: '2026-05', amount: 123456789,
    });
    expect(toDriverDef(normaliseLine({ ...base, kind: 'pct_of_line', pct: 38, ref: { glAccountId: R, cc1Id: C, cc2Id: null, buId: null } })))
      .toMatchObject({ refRowKey: `${R}|${C}||`, pct: 38 });
  });

  it('refuses part cents and an amount past NUMERIC(15,2) (DriverRangeError); percent bounds are the engine\'s', () => {
    expect(() => toDriverDef(normaliseLine({ ...base, kind: 'fixed', amount: 0.001 }))).toThrow(DriverRangeError);
    expect(() => toDriverDef(normaliseLine({ ...base, kind: 'per_head', amount: 1e14 }))).toThrow(DriverRangeError);
    expect(toDriverDef(normaliseLine({ ...base, kind: 'growth', pct: 2.5, baseMonth: '2026-02' }))).toMatchObject({ pct: 2.5, baseMonth: '2026-02' });
  });
});
