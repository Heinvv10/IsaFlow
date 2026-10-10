/**
 * mirrorLegacyCostCentre — the writer half of "CC1 is cc1_id alone" (PR #688
 * round 2). `sql` only serves this company's cost_centres rows; the SQL itself
 * and the posting path run in tests/integration/legacy-cost-centre-mirror.int.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
const warn = vi.fn();
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: (...a: unknown[]) => warn(...a), debug: vi.fn() } }));

import { mirrorLegacyCostCentre } from '@/modules/accounting/services/gl/legacyCostCentreMirror';

const CO = '11111111-1111-4111-8111-111111111111';
const FNO = 'aaaaaaaa-0000-4000-8000-000000000001';
const FNO2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const PRJ = 'aaaaaaaa-0000-4000-8000-000000000003';
const PRJ2 = 'aaaaaaaa-0000-4000-8000-000000000004';
const FOREIGN = 'bbbbbbbb-0000-4000-8000-000000000001';
const line = (extra: Record<string, string>) => ({ glAccountId: 'acc', debit: 1, credit: 0, ...extra });

beforeEach(() => {
  sqlMock.mockReset();
  warn.mockReset();
  // This company's centres: FNO / FNO2 are CC1, PRJ / PRJ2 are CC2. FOREIGN is not this company's.
  sqlMock.mockResolvedValue([
    { id: FNO, cc_type: 'cc1' }, { id: FNO2, cc_type: 'cc1' }, { id: PRJ, cc_type: 'cc2' }, { id: PRJ2, cc_type: 'cc2' },
  ]);
});

describe('mirrorLegacyCostCentre', () => {
  it('a CC1 becomes cc1Id; a CC2 becomes cc2Id; an explicit CC1 or CC2 is never overridden', async () => {
    const out = await mirrorLegacyCostCentre(CO, [
      line({ costCenterId: FNO }),
      line({ costCenterId: PRJ }),
      line({ costCenterId: FNO, cc1Id: FNO2 }),
      line({ costCenterId: PRJ, cc2Id: PRJ2 }),
      line({}),
    ]);
    expect(out.map((l) => [l.cc1Id ?? null, l.cc2Id ?? null, l.costCenterId ?? null])).toEqual([
      [FNO, null, FNO],
      [null, PRJ, PRJ],
      [FNO2, null, FNO],
      [null, PRJ2, PRJ],
      [null, null, null],
    ]);
    expect(warn).toHaveBeenCalledTimes(1); // the CC2 on a line that already has one
  });

  it('an id this company does not own is left as it is (the ownership check refuses it), with a warning', async () => {
    const [out] = await mirrorLegacyCostCentre(CO, [line({ costCenterId: FOREIGN })]);
    expect(out).toEqual(line({ costCenterId: FOREIGN }));
    expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ costCenterId: FOREIGN }), 'accounting');
  });

  it('reads only this company\'s centres, once, and not at all when no line needs it', async () => {
    await mirrorLegacyCostCentre(CO, [line({ costCenterId: FNO }), line({ costCenterId: PRJ })]);
    expect(sqlMock).toHaveBeenCalledTimes(1);
    expect(sqlMock.mock.calls[0]!.slice(1)).toEqual([CO, [FNO, PRJ]]);
    sqlMock.mockClear();
    await mirrorLegacyCostCentre(CO, [line({ cc1Id: FNO, costCenterId: FNO }), line({ costCenterId: 'not-a-uuid' }), line({})]);
    expect(sqlMock).not.toHaveBeenCalled();
  });
});
