/**
 * Dimensions Phase 1 — a typed reference (UUID, code or alias) resolves to the
 * canonical id, in the right slot, active, company-scoped.
 */
import { beforeEach, describe, expect, it, vi, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));

import { sql } from '@/lib/neon';
import { aliasKey, matchMasterRow, resolveDimensionRefs } from '@/modules/accounting/services/gl/dimensions/dimensionRefResolver';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const COMPANY = '11111111-1111-4111-8111-111111111111';
const FT = 'aaaaaaaa-0000-4000-8000-000000000001';
const PHALABORWA = 'cccccccc-0000-4000-8000-000000000001';
const MAINT = 'dddddddd-0000-4000-8000-000000000001';

describe('aliasKey / matchMasterRow (pure)', () => {
  it('normalises case and whitespace', () => {
    expect(aliasKey('  Ben   Farms ')).toBe('ben farms');
  });
  it('matches an exact code first, then a unique case-folded one', () => {
    const rows = [{ id: FT, code: 'FT', is_active: true }];
    expect(matchMasterRow('FT', rows)?.id).toBe(FT);
    expect(matchMasterRow('ft', rows)?.id).toBe(FT);
    expect(matchMasterRow('FX', rows)).toBeNull();
  });
  it('does not guess between two case-folded twins', () => {
    const rows = [{ id: 'a', code: 'Lawley', is_active: true }, { id: 'b', code: 'LAWLEY', is_active: true }];
    expect(matchMasterRow('lawley', rows)).toBeNull();
  });
});

describe('resolveDimensionRefs', () => {
  beforeEach(() => mockSql.mockReset());

  it('sends no query when no line names a dimension', async () => {
    expect(await resolveDimensionRefs(COMPANY, [undefined, {}])).toEqual([undefined, undefined]);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('resolves a code (CC1), an ALIAS (CC2) and a BU code to canonical ids', async () => {
    mockSql
      .mockResolvedValueOnce([{ id: FT, code: 'FIBERTIME', cc_type: 'cc1', is_active: true }]) // cost centres by id/code
      .mockResolvedValueOnce([{ alias_normalized: 'ben farms', id: PHALABORWA, code: 'PHALABORWA-BF', cc_type: 'cc2', is_active: true }])
      .mockResolvedValueOnce([{ id: MAINT, code: 'MAINT', is_active: true }]); // business units
    const [ids] = await resolveDimensionRefs(COMPANY, [{ cc1: 'fibertime', cc2: 'Ben Farms', bu: 'MAINT' }]);
    expect(ids).toEqual({ cc1Id: FT, cc2Id: PHALABORWA, buId: MAINT });
    // Every lookup is company-scoped.
    for (const call of mockSql.mock.calls) {
      expect((call[0] as string[]).join('?')).toMatch(/company_id = \?::UUID/);
    }
  });

  it('refuses a CC1 reference in the CC2 slot (dimensions never substitute for one another)', async () => {
    mockSql.mockResolvedValueOnce([{ id: FT, code: 'FIBERTIME', cc_type: 'cc1', is_active: true }]);
    await expect(resolveDimensionRefs(COMPANY, [{ cc2: 'FIBERTIME' }], (i) => `lines[${i}]`))
      .rejects.toThrow('lines[0].cc2 "FIBERTIME" does not name an active CC2 (project) cost centre in this company');
  });

  it('refuses an inactive or unknown reference, and a foreign UUID reads like a miss', async () => {
    mockSql.mockResolvedValueOnce([{ id: FT, code: 'FIBERTIME', cc_type: 'cc1', is_active: false }])
      .mockResolvedValueOnce([]);
    await expect(resolveDimensionRefs(COMPANY, [{ cc1: 'FIBERTIME' }])).rejects.toThrow(/does not name an active CC1/);
    mockSql.mockReset();
    mockSql.mockResolvedValueOnce([]);
    await expect(resolveDimensionRefs(COMPANY, [{ cc1: FT }])).rejects.toThrow(/does not name an active CC1/);
  });
});
