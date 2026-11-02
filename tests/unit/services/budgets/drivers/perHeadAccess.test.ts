/**
 * perHeadAccess (budgets decision 15, POPIA): a budget writer (owner / admin / manager) sees every
 * driver line whole; anyone else gets per_head lines with the `amount` KEY removed (not nulled)
 * and `perHeadRestricted: true`, every other kind untouched. A one-person cost centre is the case
 * that matters: its per_head rate is that person's budgeted pay.
 *
 * Mutation check: make `perHeadAccessOf` answer 'full' for a viewer, null the amount instead of
 * removing it, or redact for 'full', and a test here goes red.
 */
import { describe, expect, it } from 'vitest';
import type { StoredDriverLine } from '@/modules/accounting/services/budgets/drivers/driverLine';
import {
  isRestrictedPerHead, perHeadAccessOf, visibleDriverLines,
} from '@/modules/accounting/services/budgets/drivers/perHeadAccess';

const SOLO = 'cccccccc-0000-4000-8000-000000000001';
const base = {
  cc2Id: null, buId: null, fromMonth: '2026-03', toMonth: '2027-02', pct: null, ref: null, section: null, scope: null,
  baseMonth: null, rounding: 1 as const, updatedAt: '2026-10-30T06:00:00.000001Z',
};
/** A cost centre with ONE employee: R 32 017 per head is that person's budgeted pay. */
const perHead: StoredDriverLine = {
  ...base, id: 'd-head', glAccountId: 'aaaaaaaa-0000-4000-8000-000000000001', cc1Id: SOLO, kind: 'per_head', amount: 32017, headcountCostCentreId: SOLO,
};
const fixed: StoredDriverLine = {
  ...base, id: 'd-fixed', glAccountId: 'aaaaaaaa-0000-4000-8000-000000000002', cc1Id: null, kind: 'fixed', amount: 1500, headcountCostCentreId: null,
};

describe('perHeadAccessOf', () => {
  it('gives per-head detail to the budget write roles only', () => {
    expect(['owner', 'admin', 'manager'].map(perHeadAccessOf)).toEqual(['full', 'full', 'full']);
    expect(['viewer', 'accountant', '', 'Owner'].map(perHeadAccessOf)).toEqual(['totals', 'totals', 'totals', 'totals']);
    expect(perHeadAccessOf(null)).toBe('totals');
    expect(perHeadAccessOf(undefined)).toBe('totals');
  });
});

describe('visibleDriverLines', () => {
  it('a writer gets every line whole, the per-head rate included', () => {
    const out = visibleDriverLines([perHead, fixed], 'full');
    expect(out).toEqual([perHead, fixed]);
    expect(out.some(isRestrictedPerHead)).toBe(false);
  });

  it('a reader gets the one-person centre\'s per_head line with no amount key, flagged; nothing else changes', () => {
    const [head, other] = visibleDriverLines([perHead, fixed], 'totals');
    expect(head).not.toHaveProperty('amount');
    expect(Object.keys(head!)).not.toContain('amount');
    expect(head).toMatchObject({ id: 'd-head', kind: 'per_head', cc1Id: SOLO, headcountCostCentreId: SOLO, perHeadRestricted: true });
    expect(isRestrictedPerHead(head!)).toBe(true);
    // On the wire: the rate appears nowhere.
    expect(JSON.stringify(head)).not.toMatch(/32017|"amount"/);
    expect(other).toEqual(fixed);
    expect(isRestrictedPerHead(other!)).toBe(false);
  });

  it('does not change the lines it was given', () => {
    visibleDriverLines([perHead], 'totals');
    expect(perHead.amount).toBe(32017);
  });
});
