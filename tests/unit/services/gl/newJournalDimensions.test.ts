/**
 * assertNewJournalDimensions (gl/dimensions/dimensionPolicy, PR #688 round 5):
 * the dimension checks createJournalEntry runs on a NEW journal, for a caller
 * that must refuse before its first write. createJournalEntry raises "CC1 must
 * name an active CC1…" as a plain Error, which a route cannot tell from a
 * fault: an active project under an INACTIVE FNO was a 500 on the expense-claim
 * and both recurring routes. Here every such refusal is a
 * PreWriteDimensionRefusal, and a database error stays what it is.
 * `sql` only serves this company's cost centres.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { assertNewJournalDimensions } from '@/modules/accounting/services/gl/dimensions/dimensionPolicy';
import { CostCentrePickRefusal } from '@/modules/accounting/services/gl/dimensions/costCentrePick';
import { PreWriteDimensionRefusal } from '@/modules/accounting/services/gl/dimensions/dimensionTypes';

const CO = '11111111-1111-4111-8111-111111111111';
const FT = 'aaaaaaaa-0000-4000-8000-000000000001';
const OLD = 'aaaaaaaa-0000-4000-8000-000000000002'; // an inactive FNO
const P_FT = 'aaaaaaaa-0000-4000-8000-000000000003'; // a project under FT
const P_OLD = 'aaaaaaaa-0000-4000-8000-000000000004'; // an ACTIVE project under the inactive FNO
const CENTRES = [
  { id: FT, code: 'FT', cc_type: 'cc1', is_active: true, parent_id: null },
  { id: OLD, code: 'OLD', cc_type: 'cc1', is_active: false, parent_id: null },
  { id: P_FT, code: 'P-FT', cc_type: 'cc2', is_active: true, parent_id: FT },
  { id: P_OLD, code: 'P-OLD', cc_type: 'cc2', is_active: true, parent_id: OLD },
];
const line = (extra: Record<string, string>) => ({ glAccountId: 'acc', debit: 5, credit: 0, ...extra });
const refusal = (lines: Array<ReturnType<typeof line>>, source: 'manual' | 'auto_payment' = 'manual') =>
  assertNewJournalDimensions(CO, source, lines).then(() => null, (e: unknown) => e as Error & { lineIndex?: number });

beforeEach(() => {
  sqlMock.mockReset();
  sqlMock.mockImplementation((strings: string[], _co: unknown, ids: string[]) =>
    Promise.resolve(strings.join('').includes('RECURSIVE') ? CENTRES : CENTRES.filter((c) => ids.includes(c.id))));
});

describe('assertNewJournalDimensions', () => {
  it('passes what createJournalEntry would post: a CC1, a project (its FNO derived), no dimensions at all', async () => {
    expect(await refusal([line({ cc1Id: FT }), line({ cc2Id: P_FT }), line({})])).toBeNull();
  });

  it('an active project under an inactive FNO is a pre-write refusal with the validator\'s message', async () => {
    const err = await refusal([line({ cc2Id: P_OLD })]);
    expect(err).toBeInstanceOf(PreWriteDimensionRefusal);
    expect(err!.message).toBe('CC1 must name an active CC1 cost centre in this company');
  });

  it('an inactive CC1, a project under another FNO, and dimensions on a settlement are pre-write refusals too', async () => {
    expect(await refusal([line({ cc1Id: OLD })])).toBeInstanceOf(PreWriteDimensionRefusal);
    const conflict = await refusal([line({ cc1Id: FT, cc2Id: P_OLD })]);
    expect(conflict).toBeInstanceOf(PreWriteDimensionRefusal);
    expect(conflict!.message).toContain('project P-OLD belongs to FNO OLD, but CC1 FT was given');
    expect(await refusal([line({ cc1Id: FT })], 'auto_payment')).toBeInstanceOf(PreWriteDimensionRefusal);
  });

  it('carries the line the refusal is about — not the first tagged line — and none for a whole-journal refusal', async () => {
    // Line 1 is fine; line 3 is the project under the inactive FNO.
    expect((await refusal([line({ cc1Id: FT }), line({}), line({ cc2Id: P_OLD }), line({})]))!.lineIndex).toBe(2);
    expect((await refusal([line({ cc2Id: P_FT }), line({ cc1Id: OLD })]))!.lineIndex).toBe(1);
    // A conflict is derivation's own refusal: the index is the line its message names.
    const conflict = await refusal([line({ cc1Id: FT }), line({ cc1Id: FT, cc2Id: P_OLD })]);
    expect([conflict!.lineIndex, conflict!.message.startsWith('Line 2: ')]).toEqual([1, true]);
    // Dimensions on a settlement are about the journal: no line.
    expect((await refusal([line({}), line({ cc1Id: FT })], 'auto_payment'))!.lineIndex).toBeUndefined();
  });

  it('a line still carrying a bare costCenterId is a CostCentrePickRefusal naming it, raised before any database read', async () => {
    const err = await refusal([line({ cc1Id: FT }), line({ costCenterId: FT })]);
    expect(err).toBeInstanceOf(CostCentrePickRefusal);
    expect(err).toBeInstanceOf(PreWriteDimensionRefusal);
    expect([err!.lineIndex, err!.message.startsWith('Line 2: ')]).toEqual([1, true]);
    // First, ahead of the settlement check (which has no line): the pick is the more specific refusal.
    expect(await refusal([line({ costCenterId: FT })], 'auto_payment')).toBeInstanceOf(CostCentrePickRefusal);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('a database error is not a refusal: it propagates as it is', async () => {
    const down = Object.assign(new Error('connection terminated'), { code: '57P01' });
    sqlMock.mockRejectedValue(down);
    const err = await refusal([line({ cc1Id: FT })]);
    expect(err).toBe(down);
    expect(err).not.toBeInstanceOf(PreWriteDimensionRefusal);
  });
});
