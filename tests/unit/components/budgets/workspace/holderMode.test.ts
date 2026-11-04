/**
 * Budgets P5-6 grid holder mode (holderMode.ts + pivot's `readReason`): a holder's row is editable
 * only in a view that is one of their open/returned slices on a draft, and the grid opens on their
 * slice. Owners and admins (no `holder` in the model) are not touched.
 */
import { describe, expect, it } from 'vitest';
import { holderRule, holderView } from '@/components/accounting/budgets/workspace/holderMode';
import { resolveView } from '@/modules/accounting/services/budgets/grid/pivot';
import type { GridReadModel } from '@/modules/accounting/services/budgets/gridReadTypes';
import { OUTSIDE_SLICE_REASON, SUBMITTED_SLICE_REASON, NOT_DRAFT_REASON } from '@/modules/accounting/services/budgets/holderSlices';

const model = (holder: GridReadModel['holder'], status = 'draft') => ({ holder, version: { status } } as unknown as GridReadModel);
const H = { slices: [
  { cc1Id: 'ops', cc2Id: null, buId: null, glAccountIds: null, status: 'open' as const },
  { cc1Id: null, cc2Id: null, buId: 'bu', glAccountIds: ['rent'], status: 'submitted' as const },
] };
const row = (m: GridReadModel, view: Parameters<typeof resolveView>[1], acct = 'rent') =>
  resolveView({ accountIds: [acct], months: ['2030-03'], cells: new Map(), canWrite: true, readReason: holderRule(m) }, view).get(acct)!;

describe('holder mode', () => {
  it('editable in an open slice view; read-only (with why) elsewhere', () => {
    const m = model(H);
    expect(row(m, { kind: 'cc1', memberId: 'ops' })).toMatchObject({ editable: true });
    expect(row(m, { kind: 'company' })).toMatchObject({ editable: false, readReason: OUTSIDE_SLICE_REASON });
    expect(row(m, { kind: 'bu', memberId: 'bu' })).toMatchObject({ editable: false, readReason: SUBMITTED_SLICE_REASON });
    expect(row(m, { kind: 'bu', memberId: 'bu' }, 'sales')).toMatchObject({ editable: false, readReason: OUTSIDE_SLICE_REASON });
    expect(row(model(H, 'approved'), { kind: 'cc1', memberId: 'ops' })).toMatchObject({ editable: false, readReason: NOT_DRAFT_REASON });
  });

  it('no holder: the pivot is as before', () => {
    expect(holderRule(model(null))).toBeNull();
    expect(row(model(null), { kind: 'company' })).toMatchObject({ editable: true });
  });

  it('opens on the first slice unless they hold the company level', () => {
    expect(holderView(model(H), { kind: 'company' })).toEqual({ kind: 'cc1', memberId: 'ops' });
    expect(holderView(model({ slices: [{ ...H.slices[0]!, cc1Id: null }] }), { kind: 'company' })).toEqual({ kind: 'company' });
    expect(holderView(model(H), { kind: 'bu', memberId: 'bu' })).toEqual({ kind: 'bu', memberId: 'bu' });
    expect(holderView(model(null), { kind: 'company' })).toEqual({ kind: 'company' });
  });
});
