/**
 * The cost-centre pick rule (gl/dimensions/costCentrePick, PR #688 rounds 3-4):
 * the one function every legacy `costCenterId` writer now runs. `sql` only
 * serves this company's cost_centres rows and parent chains; the writers
 * themselves run in tests/integration/cost-centre-pick-writers.int.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
const warn = vi.fn();
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: (...a: unknown[]) => warn(...a), debug: vi.fn() } }));

import {
  COST_CENTRE_NOT_A_CC1_OR_CC2,
  COST_CENTRE_OUTSIDE_COMPANY,
  CostCentrePickRefusal,
  costCentreSlot,
  placeCostCentres,
} from '@/modules/accounting/services/gl/dimensions/costCentrePick';
import { isDimensionRefusal } from '@/modules/accounting/services/gl/dimensions/dimensionTypes';

const CO = '11111111-1111-4111-8111-111111111111';
const FNO = 'aaaaaaaa-0000-4000-8000-000000000001';
const FNO2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const PRJ = 'aaaaaaaa-0000-4000-8000-000000000003'; // under FNO
const PRJ2 = 'aaaaaaaa-0000-4000-8000-000000000004'; // under FNO2
const OLD = 'aaaaaaaa-0000-4000-8000-000000000005';
const UNTYPED = 'aaaaaaaa-0000-4000-8000-000000000006';
const ORPHAN = 'aaaaaaaa-0000-4000-8000-000000000007'; // a project whose chain reaches no FNO
const FOREIGN = 'bbbbbbbb-0000-4000-8000-000000000001';
const cc1 = { ccType: 'cc1', isActive: true };
const cc2 = { ccType: 'cc2', isActive: true };

describe('costCentreSlot — the rule on a new assignment', () => {
  it('a CC1 fills cc1 only on a line with no CC1 and no CC2', () => {
    expect(costCentreSlot(FNO, cc1, {})).toEqual({ kind: 'cc1' });
    expect(costCentreSlot(FNO, cc1, { buId: 'b' })).toEqual({ kind: 'cc1' });
    // With a CC2, derivation supplies the CC1: a header FNO must not contradict the project's.
    expect(costCentreSlot(FNO, cc1, { cc2Id: PRJ })).toEqual({ kind: 'drop', reason: 'occupied' });
    expect(costCentreSlot(FNO, cc1, { cc1Id: FNO2 })).toEqual({ kind: 'drop', reason: 'occupied' });
  });

  it('a CC2 fills cc2 when the line has none; derivation and its conflict check follow', () => {
    expect(costCentreSlot(PRJ, cc2, {})).toEqual({ kind: 'cc2' });
    expect(costCentreSlot(PRJ, cc2, { cc1Id: FNO2 })).toEqual({ kind: 'cc2' });
    expect(costCentreSlot(PRJ, cc2, { cc2Id: PRJ2 })).toEqual({ kind: 'drop', reason: 'occupied' });
  });

  it('a pick that repeats what its slot holds is not a drop', () => {
    expect(costCentreSlot(FNO, cc1, { cc1Id: FNO.toUpperCase() })).toEqual({ kind: 'same' });
    expect(costCentreSlot(PRJ, cc2, { cc2Id: PRJ })).toEqual({ kind: 'same' });
    expect(costCentreSlot(FNO, { ccType: 'cc1', isActive: false }, { cc1Id: FNO })).toEqual({ kind: 'same' });
  });

  it('an inactive centre is dropped; a foreign or untyped one is refused', () => {
    expect(costCentreSlot(OLD, { ccType: 'cc1', isActive: false }, {})).toEqual({ kind: 'drop', reason: 'inactive' });
    expect(costCentreSlot(OLD, { ccType: 'cc2', isActive: false }, {})).toEqual({ kind: 'drop', reason: 'inactive' });
    expect(costCentreSlot(FOREIGN, undefined, {})).toEqual({ kind: 'refuse', message: COST_CENTRE_OUTSIDE_COMPANY });
    for (const ccType of [null, '', 'CC1', 'legacy']) {
      expect(costCentreSlot(UNTYPED, { ccType, isActive: true }, {})).toEqual({ kind: 'refuse', message: COST_CENTRE_NOT_A_CC1_OR_CC2 });
    }
  });
});

describe('costCentreSlot — a stored posting (AP): a CC2 pick brings its FNO', () => {
  const under = (fnoId: string | null) => ({ ...cc2, fnoId });
  it('no CC1 on the line: the project\'s FNO becomes the CC1', () => {
    expect(costCentreSlot(PRJ, under(FNO), {})).toEqual({ kind: 'cc2', cc1Id: FNO });
    expect(costCentreSlot(ORPHAN, under(null), {})).toEqual({ kind: 'cc2' });
  });
  it('a CC1 on the line: the project is placed only when its FNO is that CC1', () => {
    expect(costCentreSlot(PRJ, under(FNO), { cc1Id: FNO.toUpperCase() })).toEqual({ kind: 'cc2' });
    expect(costCentreSlot(PRJ, under(FNO), { cc1Id: FNO2 })).toEqual({ kind: 'drop', reason: 'conflict' });
    expect(costCentreSlot(ORPHAN, under(null), { cc1Id: FNO })).toEqual({ kind: 'drop', reason: 'conflict' });
  });
  it('the line\'s own project still wins', () => {
    expect(costCentreSlot(PRJ, under(FNO), { cc2Id: PRJ2 })).toEqual({ kind: 'drop', reason: 'occupied' });
  });
});

describe('placeCostCentres', () => {
  const line = (extra: Record<string, string>) => ({ glAccountId: 'acc', debit: 7, credit: 0, ...extra });
  const CENTRES = [
    { id: FNO, code: 'FT', cc_type: 'cc1', is_active: true, parent_id: null },
    { id: FNO2, code: 'HT', cc_type: 'cc1', is_active: true, parent_id: null },
    { id: PRJ, code: 'P-FT', cc_type: 'cc2', is_active: true, parent_id: FNO },
    { id: PRJ2, code: 'P-HT', cc_type: 'cc2', is_active: true, parent_id: FNO2 },
    { id: OLD, code: 'OLD', cc_type: 'cc1', is_active: false, parent_id: null },
    { id: UNTYPED, code: 'UNT', cc_type: null, is_active: true, parent_id: null },
  ];
  beforeEach(() => {
    sqlMock.mockReset();
    warn.mockReset();
    // The centre read is bound (company, ids); the chain read (stored posting) returns every node.
    sqlMock.mockImplementation((strings: string[], _co: unknown, ids: string[]) =>
      Promise.resolve(strings.join('').includes('RECURSIVE') ? CENTRES : CENTRES.filter((c) => ids.includes(c.id))));
  });
  const chainReads = () => sqlMock.mock.calls.filter((c) => (c[0] as string[]).join('').includes('RECURSIVE')).length;

  it('moves each pick to its slot and never returns a costCenterId', async () => {
    const out = await placeCostCentres(CO, [
      line({ costCenterId: FNO }),
      line({ costCenterId: PRJ }),
      line({ costCenterId: FNO, cc2Id: PRJ }),
      line({ costCenterId: FNO, cc1Id: FNO2 }),
      line({ costCenterId: PRJ, cc2Id: PRJ2 }),
      line({ costCenterId: OLD }),
      line({ costCenterId: FNO, cc1Id: FNO }),
      line({}),
    ]);
    expect(out.lines).toEqual([
      line({ cc1Id: FNO }),
      line({ cc2Id: PRJ }),
      line({ cc2Id: PRJ }),
      line({ cc1Id: FNO2 }),
      line({ cc2Id: PRJ2 }),
      line({}),
      line({ cc1Id: FNO }),
      line({}),
    ]);
    expect(out.lines.some((l) => 'costCenterId' in l)).toBe(false);
    // A new assignment reads no chain: derivation does that, after.
    expect(chainReads()).toBe(0);
  });

  it('reports every drop — by line and code in `warnings`, by id in the log — and nothing for a repeat', async () => {
    const out = await placeCostCentres(CO, [
      line({ costCenterId: OLD }),
      line({ costCenterId: FNO, cc2Id: PRJ }),
      line({ costCenterId: FNO, cc1Id: FNO }),
      line({ costCenterId: PRJ, cc1Id: FNO2 }),
    ], { storedPosting: true });
    expect(out.warnings).toEqual([
      'Line 1: cost centre OLD is inactive and was not applied — the line posts without it.',
      'Line 2: cost centre FT was not applied — the line already carries its own CC1 or project.',
      'Line 4: project P-FT was not applied — it belongs to another FNO than the line\'s CC1.',
    ]);
    expect(warn.mock.calls.map((c) => [c[0], c[1], c[2]])).toEqual([
      ['Cost centre pick dropped from a journal line (inactive)', { companyId: CO, costCentreId: OLD }, 'accounting'],
      ['Cost centre pick dropped from a journal line (occupied)', { companyId: CO, costCentreId: FNO }, 'accounting'],
      ['Cost centre pick dropped from a journal line (conflict)', { companyId: CO, costCentreId: PRJ }, 'accounting'],
    ]);
    expect((await placeCostCentres(CO, [line({ costCenterId: FNO })])).warnings).toEqual([]);
  });

  it('a stored posting derives the FNO of a project pick, and never stores a conflicting pair', async () => {
    const out = await placeCostCentres(CO, [
      line({ costCenterId: PRJ2 }),
      line({ costCenterId: PRJ2, cc1Id: FNO2 }),
      line({ costCenterId: PRJ2, cc1Id: FNO }),
    ], { storedPosting: true });
    expect(out.lines).toEqual([line({ cc2Id: PRJ2, cc1Id: FNO2 }), line({ cc1Id: FNO2, cc2Id: PRJ2 }), line({ cc1Id: FNO })]);
    expect(chainReads()).toBe(1);
    // The same picks on a new assignment are placed as they are: createJournalEntry derives and refuses.
    const fresh = await placeCostCentres(CO, [line({ costCenterId: PRJ2 }), line({ costCenterId: PRJ2, cc1Id: FNO })]);
    expect(fresh.lines).toEqual([line({ cc2Id: PRJ2 }), line({ cc1Id: FNO, cc2Id: PRJ2 })]);
  });

  it('refuses a foreign, a malformed and an untyped pick — a DimensionRefusal naming the line', async () => {
    const refusal = async (lines: Array<Record<string, unknown>>) =>
      placeCostCentres(CO, lines as never).then(() => null, (e: unknown) => e as CostCentrePickRefusal);
    const foreign = await refusal([line({ costCenterId: FNO }), line({ costCenterId: FOREIGN })]);
    expect(foreign).toBeInstanceOf(CostCentrePickRefusal);
    expect(isDimensionRefusal(foreign)).toBe(true);
    expect([foreign!.message, foreign!.lineIndex]).toEqual([COST_CENTRE_OUTSIDE_COMPANY, 1]);
    const untyped = await refusal([line({}), line({}), line({ costCenterId: UNTYPED })]);
    expect([untyped!.message, untyped!.lineIndex]).toEqual([COST_CENTRE_NOT_A_CC1_OR_CC2, 2]);
    sqlMock.mockClear();
    const malformed = await refusal([line({ costCenterId: 'not-a-uuid' })]);
    expect([malformed!.message, malformed!.lineIndex]).toEqual([COST_CENTRE_OUTSIDE_COMPANY, 0]);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('reads only this company\'s centres, once, and not at all when nothing is picked', async () => {
    await placeCostCentres(CO, [line({ costCenterId: FNO }), line({ costCenterId: PRJ }), line({ costCenterId: FNO })]);
    expect(sqlMock).toHaveBeenCalledTimes(1);
    expect(sqlMock.mock.calls[0]!.slice(1)).toEqual([CO, [FNO, PRJ]]);
    sqlMock.mockClear();
    expect((await placeCostCentres(CO, [line({ cc1Id: FNO }), line({})], { storedPosting: true })).lines).toEqual([line({ cc1Id: FNO }), line({})]);
    expect(sqlMock).not.toHaveBeenCalled();
  });
});
