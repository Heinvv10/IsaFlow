/**
 * Budgets P5-6: the pure slice rules both sides share. The status machine (sliceReviewState's
 * nextSliceStatus: who may move a slice from where), the note rule, and the holder-slice predicates
 * (holderSlices: a cell inside a slice, why a holder may not change it).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withSavepoint: vi.fn() }));

import { nextSliceStatus, sliceNote, MAX_SLICE_NOTE } from '@/modules/accounting/services/budgets/sliceReviewState';
import {
  APPROVED_SLICE_REASON, holderReadReason, NOT_DRAFT_REASON, OUTSIDE_SLICE_REASON, sliceLabel, sliceOf, SUBMITTED_SLICE_REASON,
  type HolderSlice,
} from '@/modules/accounting/services/budgets/holderSlices';

const holder = { holder: true, reviewer: false };
const reviewer = { holder: false, reviewer: true };

describe('nextSliceStatus', () => {
  it.each([
    ['open', 'submit', holder, 'submitted'], ['returned', 'submit', holder, 'submitted'],
    ['submitted', 'approve', reviewer, 'approved'], ['submitted', 'return', reviewer, 'returned'],
  ] as const)('%s --%s--> %s', (from, action, who, to) => {
    expect(nextSliceStatus(from, action, who)).toEqual({ ok: true, next: to });
  });

  it.each([
    ['submitted', 'submit', holder], ['approved', 'submit', holder], ['open', 'approve', reviewer], ['returned', 'approve', reviewer],
    ['approved', 'return', reviewer], ['open', 'return', reviewer],
  ] as const)('%s cannot be %s-ed (409 STATE)', (from, action, who) => {
    expect(nextSliceStatus(from, action, who)).toMatchObject({ ok: false, code: 'BUDGET_SLICE_STATE' });
  });

  it('only a holder submits; only an owner/admin approves or returns (403)', () => {
    expect(nextSliceStatus('open', 'submit', reviewer)).toMatchObject({ ok: false, code: 'BUDGET_SLICE_FORBIDDEN' });
    expect(nextSliceStatus('submitted', 'approve', holder)).toMatchObject({ ok: false, code: 'BUDGET_SLICE_FORBIDDEN' });
    expect(nextSliceStatus('submitted', 'return', { holder: true, reviewer: false })).toMatchObject({ ok: false, code: 'BUDGET_SLICE_FORBIDDEN' });
  });
});

describe('sliceNote', () => {
  it('a return needs a note; an approve may carry one; a submit never does', () => {
    expect(() => sliceNote('return', '   ')).toThrow(/needs a note/);
    expect(sliceNote('return', '  Trim it ')).toBe('Trim it');
    expect(sliceNote('approve', '')).toBeNull();
    expect(sliceNote('approve', 'ok')).toBe('ok');
    expect(sliceNote('submit', 'ignored')).toBeNull();
    expect(() => sliceNote('approve', 'x'.repeat(MAX_SLICE_NOTE + 1))).toThrow(/at most/);
  });
});

describe('holder slices', () => {
  const S: HolderSlice[] = [
    { cc1Id: 'AAA', cc2Id: null, buId: null, glAccountIds: null, status: 'open' },
    { cc1Id: null, cc2Id: null, buId: 'bu1', glAccountIds: ['acc1'], status: 'submitted' },
    { cc1Id: null, cc2Id: 'c2', buId: null, glAccountIds: null, status: 'approved' },
  ];
  const at = (glAccountId: string, dims: Partial<{ cc1Id: string; cc2Id: string; buId: string }> = {}) =>
    ({ glAccountId, cc1Id: dims.cc1Id ?? null, cc2Id: dims.cc2Id ?? null, buId: dims.buId ?? null });

  it('a cell is inside a slice by its exact dimensions (case-insensitive ids) and, when the row names accounts, its account', () => {
    expect(sliceOf(S, at('any', { cc1Id: 'aaa' }))).toBe(S[0]);
    expect(sliceOf(S, at('ACC1', { buId: 'bu1' }))).toBe(S[1]);
    expect(sliceOf(S, at('acc2', { buId: 'bu1' }))).toBeNull();
    expect(sliceOf(S, at('any'))).toBeNull();
    expect(sliceOf(S, at('any', { cc1Id: 'aaa', buId: 'bu1' }))).toBeNull();
  });

  it('why a holder may not change a cell', () => {
    expect(holderReadReason(S, 'draft', at('x', { cc1Id: 'AAA' }))).toBeNull();
    expect(holderReadReason(S, 'approved', at('x', { cc1Id: 'AAA' }))).toBe(NOT_DRAFT_REASON);
    expect(holderReadReason(S, 'draft', at('x'))).toBe(OUTSIDE_SLICE_REASON);
    expect(holderReadReason(S, 'draft', at('acc1', { buId: 'bu1' }))).toBe(SUBMITTED_SLICE_REASON);
    expect(holderReadReason(S, 'draft', at('x', { cc2Id: 'c2' }))).toBe(APPROVED_SLICE_REASON);
  });

  it('labels', () => {
    const label = (id: string) => ({ AAA: 'OPS Operations' } as Record<string, string>)[id];
    expect(sliceLabel({ cc1Id: 'AAA', cc2Id: null, buId: null }, label)).toBe('CC1 OPS Operations');
    expect(sliceLabel({ cc1Id: null, cc2Id: null, buId: 'zz' }, label)).toBe('BU zz');
    expect(sliceLabel({ cc1Id: null, cc2Id: null, buId: null }, label)).toBe('Company level');
  });
});

describe('capped (forced-approval audit)', () => {
  it('names at most 40 slices, then +N more', async () => {
    const { capped } = await import('@/modules/accounting/services/budgets/budgetVersionStatus');
    const list = Array.from({ length: 43 }, (_, i) => `S${i}`);
    expect(capped(list.slice(0, 3))).toBe('S0; S1; S2');
    const out = capped(list);
    expect(out.split('; ')).toHaveLength(41);
    expect(out.endsWith('; +3 more')).toBe(true);
  });
});
