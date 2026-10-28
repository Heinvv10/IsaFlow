/**
 * Budgets P3 §2.4: which budget rows a dimension filter takes. Every row is
 * exactly one of included (in the Budget column), coarser (set above the
 * filter: reported as unallocated, never apportioned) or other (excluded).
 * A CC2-grain row rolls up to its FNO by the parent walk postings use.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyBudgetRow,
  effectiveDims,
  type BudgetFilter,
} from '@/modules/accounting/services/budgets/tracking/trackingDimRollup';
import type { CostCentreNode } from '@/modules/accounting/services/gl/dimensions/dimensionDerivation';
import { assertCentreLevel } from '@/modules/accounting/services/budgets/tracking/trackingFilter';
import { TrackingError } from '@/modules/accounting/services/budgets/tracking/trackingTypes';

// FNO A with project P (direct) and Q (through programme G); FNO B with project R; project N has no chain.
const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const G = '99999999-0000-4000-8000-000000000009';
const P = '11111111-0000-4000-8000-000000000001';
const Q = '22222222-0000-4000-8000-000000000002';
const R = '33333333-0000-4000-8000-000000000003';
const N = '44444444-0000-4000-8000-000000000004';
const U = '55555555-0000-4000-8000-000000000005';
const U2 = '66666666-0000-4000-8000-000000000006';

const node = (id: string, parentId: string | null, ccType: string): [string, CostCentreNode] => [id, { id, code: id.slice(0, 4), parentId, ccType }];
const NODES = new Map<string, CostCentreNode>([
  node(A, null, 'cc1'), node(B, null, 'cc1'), node(G, A, 'cc2'),
  node(P, A, 'cc2'), node(Q, G, 'cc2'), node(R, B, 'cc2'), node(N, null, 'cc2'),
]);

const row = (cc1: string | null, cc2: string | null, bu: string | null) => effectiveDims({ cc1Id: cc1, cc2Id: cc2, buId: bu }, NODES);
const COMPANY = row(null, null, null);
const AT_A = row(A, null, null);
const AT_B = row(B, null, null);
const AT_P = row(null, P, null);
const AT_Q = row(null, Q, null);
const AT_R = row(null, R, null);
const AT_N = row(null, N, null);
const AT_U = row(null, null, U);

const cls = (eff: ReturnType<typeof row>, f: BudgetFilter) => classifyBudgetRow(eff, f);

describe('effective dimensions', () => {
  it('a CC2 row takes its FNO by the parent walk, through a programme CC2', () => {
    expect(AT_P).toEqual({ cc1: A, cc2: P, bu: null });
    expect(AT_Q).toEqual({ cc1: A, cc2: Q, bu: null });
    expect(AT_N).toEqual({ cc1: null, cc2: N, bu: null });
  });

  it('a stored CC1 that contradicts the CC2 chain is refused, not resolved', () => {
    expect(() => row(B, P, null)).toThrow(/contradicts/);
    expect(row(A, P, null)).toEqual({ cc1: A, cc2: P, bu: null });
  });
});

describe('no filter', () => {
  it('includes every row: the company roll-up is the sum of every grain', () => {
    for (const eff of [COMPANY, AT_A, AT_P, AT_N, AT_U]) expect(cls(eff, {})).toBe('included');
  });
});

describe('CC1 = A', () => {
  const f: BudgetFilter = { cc1: A };
  it('includes A and every CC2 under A (direct or through a programme)', () => {
    expect([cls(AT_A, f), cls(AT_P, f), cls(AT_Q, f)]).toEqual(['included', 'included', 'included']);
  });
  it('excludes B and CC2s under B', () => {
    expect([cls(AT_B, f), cls(AT_R, f)]).toEqual(['other', 'other']);
  });
  it('the company level, a chainless CC2 and a BU-grain row are coarser, never included', () => {
    expect([cls(COMPANY, f), cls(AT_N, f), cls(AT_U, f)]).toEqual(['coarser', 'coarser', 'coarser']);
  });
  it('is an explicit level: a CC2 id given as cc1 matches no CC2-grain row', () => {
    expect(cls(AT_P, { cc1: P })).toBe('other');
  });
});

describe('CC2 = P', () => {
  const f: BudgetFilter = { cc2: { id: P, fno: A } };
  it('includes P only', () => {
    expect([cls(AT_P, f), cls(AT_Q, f), cls(AT_R, f)]).toEqual(['included', 'other', 'other']);
  });
  it("P's own FNO and the company level are coarser (P's share is unknown)", () => {
    expect([cls(AT_A, f), cls(COMPANY, f), cls(AT_U, f)]).toEqual(['coarser', 'coarser', 'coarser']);
  });
  it('another FNO is not above P: excluded', () => {
    expect(cls(AT_B, f)).toBe('other');
    expect(cls(AT_A, { cc2: { id: N, fno: null } })).toBe('other');
  });
});

describe('BU = U', () => {
  const f: BudgetFilter = { bu: U };
  it('includes U, excludes another unit, and every non-BU grain is coarser', () => {
    expect([cls(AT_U, f), cls(row(null, null, U2), f)]).toEqual(['included', 'other']);
    expect([cls(COMPANY, f), cls(AT_A, f), cls(AT_P, f)]).toEqual(['coarser', 'coarser', 'coarser']);
  });
});

describe('two levels ANDed', () => {
  it('CC1 + BU: one-dimension budgets are all coarser or other', () => {
    const f: BudgetFilter = { cc1: A, bu: U };
    expect([cls(AT_A, f), cls(AT_P, f), cls(AT_U, f), cls(COMPANY, f)]).toEqual(['coarser', 'coarser', 'coarser', 'coarser']);
    expect([cls(AT_B, f), cls(row(null, null, U2), f)]).toEqual(['other', 'other']);
  });
});

describe('either level (cost_centre_id, the comparator)', () => {
  it('an FNO matches its own rows and its CC2s', () => {
    const f: BudgetFilter = { costCentre: { id: A } };
    expect([cls(AT_A, f), cls(AT_P, f), cls(AT_Q, f)]).toEqual(['included', 'included', 'included']);
    expect([cls(AT_B, f), cls(AT_R, f)]).toEqual(['other', 'other']);
    // Coarser only when BOTH effective cost centres are NULL (spec §2.4): the company level and a BU row.
    expect([cls(COMPANY, f), cls(AT_U, f)]).toEqual(['coarser', 'coarser']);
    // A chainless project has a CC2, so it is excluded, not unallocated (review Q10).
    expect(cls(AT_N, f)).toBe('other');
  });
  it('a project matches its own rows; a CC1-grain row (its FNO or another) is other', () => {
    const f: BudgetFilter = { costCentre: { id: P } };
    expect(cls(AT_P, f)).toBe('included');
    expect(cls(COMPANY, f)).toBe('coarser');
    expect([cls(AT_A, f), cls(AT_Q, f), cls(AT_B, f)]).toEqual(['other', 'other', 'other']);
  });
});

describe('the level of an explicit filter (review Q3)', () => {
  const centre = (ccType: string | null) => ({ id: A, code: 'FT', name: 'Fibertime', ccType });
  it('cc1_id must name a CC1 and cc2_id a CC2: the other kind is a 400', () => {
    expect(assertCentreLevel('cc1_id', centre('cc1')).id).toBe(A);
    expect(assertCentreLevel('cc2_id', centre('cc2')).id).toBe(A);
    for (const [name, type] of [['cc1_id', 'cc2'], ['cc2_id', 'cc1'], ['cc1_id', null]] as const) {
      let err: unknown;
      try { assertCentreLevel(name, centre(type)); } catch (e) { err = e; }
      expect(err, `${name} given ${String(type)}`).toBeInstanceOf(TrackingError);
      expect((err as TrackingError).status).toBe(400);
    }
  });
});
