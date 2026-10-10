/**
 * The cost-centre pick rule (gl/dimensions/costCentrePick, PR #688 round 3):
 * the one function every legacy `costCenterId` writer now runs. `sql` only
 * serves this company's cost_centres rows; the writers themselves run in
 * tests/integration/cost-centre-pick-writers.int.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
const warn = vi.fn();
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: (...a: unknown[]) => warn(...a), debug: vi.fn() } }));

import {
  COST_CENTRE_NOT_A_CC1_OR_CC2,
  COST_CENTRE_OUTSIDE_COMPANY,
  costCentreSlot,
  placeCostCentres,
} from '@/modules/accounting/services/gl/dimensions/costCentrePick';

const CO = '11111111-1111-4111-8111-111111111111';
const FNO = 'aaaaaaaa-0000-4000-8000-000000000001';
const FNO2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const PRJ = 'aaaaaaaa-0000-4000-8000-000000000003';
const PRJ2 = 'aaaaaaaa-0000-4000-8000-000000000004';
const OLD = 'aaaaaaaa-0000-4000-8000-000000000005';
const UNTYPED = 'aaaaaaaa-0000-4000-8000-000000000006';
const FOREIGN = 'bbbbbbbb-0000-4000-8000-000000000001';
const cc1 = { ccType: 'cc1', isActive: true };
const cc2 = { ccType: 'cc2', isActive: true };

describe('costCentreSlot — the rule', () => {
  it('a CC1 fills cc1 only on a line with no CC1 and no CC2', () => {
    expect(costCentreSlot(cc1, {})).toEqual({ kind: 'cc1' });
    expect(costCentreSlot(cc1, { buId: 'b' })).toEqual({ kind: 'cc1' });
    // With a CC2, derivation supplies the CC1: a header FNO must not contradict the project's.
    expect(costCentreSlot(cc1, { cc2Id: PRJ })).toEqual({ kind: 'drop', reason: 'occupied' });
    expect(costCentreSlot(cc1, { cc1Id: FNO2 })).toEqual({ kind: 'drop', reason: 'occupied' });
  });

  it('a CC2 fills cc2 when the line has none, whatever its CC1', () => {
    expect(costCentreSlot(cc2, {})).toEqual({ kind: 'cc2' });
    expect(costCentreSlot(cc2, { cc1Id: FNO })).toEqual({ kind: 'cc2' });
    expect(costCentreSlot(cc2, { cc2Id: PRJ2 })).toEqual({ kind: 'drop', reason: 'occupied' });
  });

  it('an inactive centre is dropped; a foreign or untyped one is refused', () => {
    expect(costCentreSlot({ ccType: 'cc1', isActive: false }, {})).toEqual({ kind: 'drop', reason: 'inactive' });
    expect(costCentreSlot({ ccType: 'cc2', isActive: false }, {})).toEqual({ kind: 'drop', reason: 'inactive' });
    expect(costCentreSlot(undefined, {})).toEqual({ kind: 'refuse', message: COST_CENTRE_OUTSIDE_COMPANY });
    for (const ccType of [null, '', 'CC1', 'legacy']) {
      expect(costCentreSlot({ ccType, isActive: true }, {})).toEqual({ kind: 'refuse', message: COST_CENTRE_NOT_A_CC1_OR_CC2 });
    }
  });
});

describe('placeCostCentres', () => {
  const line = (extra: Record<string, string>) => ({ glAccountId: 'acc', debit: 7, credit: 0, ...extra });
  beforeEach(() => {
    sqlMock.mockReset();
    warn.mockReset();
    sqlMock.mockResolvedValue([
      { id: FNO, cc_type: 'cc1', is_active: true }, { id: FNO2, cc_type: 'cc1', is_active: true },
      { id: PRJ, cc_type: 'cc2', is_active: true }, { id: PRJ2, cc_type: 'cc2', is_active: true },
      { id: OLD, cc_type: 'cc1', is_active: false }, { id: UNTYPED, cc_type: null, is_active: true },
    ]);
  });

  it('moves each pick to its slot and never returns a costCenterId', async () => {
    const out = await placeCostCentres(CO, [
      line({ costCenterId: FNO }),
      line({ costCenterId: PRJ }),
      line({ costCenterId: FNO, cc2Id: PRJ }),
      line({ costCenterId: FNO, cc1Id: FNO2 }),
      line({ costCenterId: PRJ, cc2Id: PRJ2 }),
      line({ costCenterId: OLD }),
      line({}),
    ]);
    expect(out).toEqual([
      line({ cc1Id: FNO }),
      line({ cc2Id: PRJ }),
      line({ cc2Id: PRJ }),
      line({ cc1Id: FNO2 }),
      line({ cc2Id: PRJ2 }),
      line({}),
      line({}),
    ]);
    expect(out.some((l) => 'costCenterId' in l)).toBe(false);
  });

  it('warns once for an inactive pick, naming the company and the centre and nothing else', async () => {
    await placeCostCentres(CO, [line({ costCenterId: OLD }), line({ costCenterId: FNO, cc2Id: PRJ })]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.any(String), { companyId: CO, costCentreId: OLD }, 'accounting');
  });

  it('refuses a foreign, a malformed and an untyped pick with the existing messages', async () => {
    await expect(placeCostCentres(CO, [line({ costCenterId: FNO }), line({ costCenterId: FOREIGN })])).rejects.toThrow(COST_CENTRE_OUTSIDE_COMPANY);
    await expect(placeCostCentres(CO, [line({ costCenterId: UNTYPED })])).rejects.toThrow(COST_CENTRE_NOT_A_CC1_OR_CC2);
    sqlMock.mockClear();
    await expect(placeCostCentres(CO, [line({ costCenterId: 'not-a-uuid' })])).rejects.toThrow(COST_CENTRE_OUTSIDE_COMPANY);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('reads only this company\'s centres, once, and not at all when nothing is picked', async () => {
    await placeCostCentres(CO, [line({ costCenterId: FNO }), line({ costCenterId: PRJ }), line({ costCenterId: FNO })]);
    expect(sqlMock).toHaveBeenCalledTimes(1);
    expect(sqlMock.mock.calls[0]!.slice(1)).toEqual([CO, [FNO, PRJ]]);
    sqlMock.mockClear();
    expect(await placeCostCentres(CO, [line({ cc1Id: FNO }), line({})])).toEqual([line({ cc1Id: FNO }), line({})]);
    expect(sqlMock).not.toHaveBeenCalled();
  });
});
