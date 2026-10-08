/**
 * A malformed CC1 / CC2 id never reaches a `::UUID[]` cast (#663 follow-up).
 *
 * loadCostCentreChains used to send every id the caller typed, so 'not-a-uuid'
 * raised Postgres "invalid input syntax for type uuid" (or, under load, hung the
 * aborted transaction) instead of the slot refusal an unknown id gets. A
 * malformed id can name no cost centre: it is left out of the query, the line
 * keeps it as typed, and the slot validator (journalCostCentreValidation)
 * refuses it exactly as it refuses an unknown one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sqlMock = vi.fn(async (..._args: unknown[]) => [] as unknown[]);
vi.mock('@/lib/neon', () => ({ sql: (...args: unknown[]) => sqlMock(...args) }));

import { deriveLineDimensions, loadCostCentreChains } from '@/modules/accounting/services/gl/dimensions/dimensionDerivation';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const VALID = '22222222-2222-4222-8222-222222222222';

beforeEach(() => sqlMock.mockClear());

describe('malformed cost-centre ids', () => {
  it('a line naming only malformed ids sends no query and is returned as typed', async () => {
    const lines = [{ cc2Id: 'not-a-uuid' }, { cc2Id: 'x', cc1Id: '1234' }];
    expect(await deriveLineDimensions(COMPANY, lines)).toEqual(lines);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('queries the well-formed ids only', async () => {
    await loadCostCentreChains(COMPANY, ['not-a-uuid', VALID.toUpperCase(), '']);
    expect(sqlMock).toHaveBeenCalledTimes(1);
    expect(sqlMock.mock.calls[0]!.slice(1)).toContainEqual([VALID]);
    expect(JSON.stringify(sqlMock.mock.calls[0]!.slice(1))).not.toContain('not-a-uuid');
  });
});
