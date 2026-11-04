/**
 * Budgets P5 §3e, the pure parts of variance notes: the filing key, the row key, the role rules, and the
 * `printsOnFixedPage` scoping (a variance row is on no pack page, so it takes no page-4 budget). The
 * database behaviour is in tests/integration/budgets-p5-variance-*.int.test.ts.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { printsOnFixedPage } from '@/modules/accounting/services/commentary/commentaryBudget';
import {
  mayApproveVarianceNote, mayWriteVarianceNote, parseVarianceRowRef, varianceRowRef,
} from '@/modules/accounting/services/commentary/varianceNoteTypes';
import { canonicalParamsHash } from '@/modules/accounting/services/reports/packParamsHash';
import { varianceMonthBounds, varianceParamsHash } from '@/modules/accounting/services/reports/varianceParamsHash';

const V = 'AAAAAAAA-1111-4111-8111-111111111111';
const A = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

describe('varianceParamsHash', () => {
  it("is sha256('bva|' || version_id || '|' || month), the version lower-cased", () => {
    expect(varianceParamsHash(V, '2026-06')).toBe(createHash('sha256').update(`bva|${V.toLowerCase()}|2026-06`).digest('hex'));
    expect(varianceParamsHash(V, '2026-06')).toBe(varianceParamsHash(V.toLowerCase(), '2026-06'));
    expect(varianceParamsHash(V, '2026-06')).not.toBe(varianceParamsHash(V, '2026-07'));
  });
  it('month bounds are the first and last day, leap February included', () => {
    expect(varianceMonthBounds('2028-02')).toEqual({ start: '2028-02-01', end: '2028-02-29' });
    expect(varianceMonthBounds('2026-06')).toEqual({ start: '2026-06-01', end: '2026-06-30' });
  });
});

describe('row_ref', () => {
  it('gl_account_id|cc1|cc2|bu with absent dimensions empty, and parses back', () => {
    const ref = varianceRowRef({ glAccountId: A, cc1Id: null, cc2Id: C, buId: null });
    expect(ref).toBe(`${A}||${C}|`);
    expect(parseVarianceRowRef(ref)).toEqual({ glAccountId: A, cc1Id: null, cc2Id: C, buId: null });
  });
  it('reads nothing it did not write', () => {
    expect(parseVarianceRowRef('revenue')).toBeNull();
    expect(parseVarianceRowRef(`|${C}||`)).toBeNull();
  });
});

describe('roles', () => {
  it('owner, admin and manager write; only owner and admin approve', () => {
    expect(['owner', 'admin', 'manager', 'viewer', 'storeman', null].map((r) => mayWriteVarianceNote(r))).toEqual([true, true, true, false, false, false]);
    expect(['owner', 'admin', 'manager', 'viewer'].map(mayApproveVarianceNote)).toEqual([true, true, false, false]);
  });
});

describe('printsOnFixedPage', () => {
  const dates = { periodStart: '2026-06-01', periodEnd: '2026-06-30' };
  it('a pack row matching no pack type is board (fail closed); a management pack row is not', () => {
    expect(printsOnFixedPage({ reportKind: 'pack', paramsHash: 'unknown', ...dates })).toBe(true);
    const mgmt = canonicalParamsHash({ type: 'management', from: dates.periodStart, to: dates.periodEnd });
    expect(printsOnFixedPage({ reportKind: 'pack', paramsHash: mgmt, ...dates })).toBe(false);
  });
  it('a budget variance row is on no pack page, whatever its hash (even a board pack\'s)', () => {
    const board = canonicalParamsHash({ type: 'board', from: dates.periodStart, to: dates.periodEnd });
    expect(printsOnFixedPage({ reportKind: 'budget_variance', paramsHash: varianceParamsHash(V, '2026-06'), ...dates })).toBe(false);
    expect(printsOnFixedPage({ reportKind: 'budget_variance', paramsHash: board, ...dates })).toBe(false);
  });
});
