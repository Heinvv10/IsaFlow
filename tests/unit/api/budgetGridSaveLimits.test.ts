/**
 * The save route's body limit, pinned to the arithmetic in its comment (round 9): Next's body
 * parser reads at most 4 MB, and MAX_SAVE_CELLS of the widest valid cell (measured here with
 * JSON.stringify, not a literal) plus the envelope fit inside it. A bigger commit is chained by
 * the client (MAX_IMPORT_CELLS over several saves).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
import { config } from '../../../pages/api/accounting/budget-grid/save';
import { MAX_IMPORT_CELLS, MAX_SAVE_CELLS } from '@/modules/accounting/services/budgets/gridSaveValidate';

const UUID = 'ffffffff-ffff-4fff-bfff-ffffffffffff';

describe('budget-grid save body limit', () => {
  it('is 4 MB, and MAX_SAVE_CELLS of the widest valid cell fit in it', () => {
    expect(config.api.bodyParser).toEqual({ sizeLimit: '4mb' });
    const widest = [
      { glAccountId: UUID, cc1Id: UUID, cc2Id: null, buId: null, month: '2026-03', amount: -9999999999999.99, clear: false },
      { glAccountId: UUID, cc1Id: UUID, cc2Id: null, buId: null, month: '2026-03', amount: null, clear: true },
    ].map((c) => JSON.stringify(c).length + 1).reduce((a, b) => Math.max(a, b));
    const envelope = JSON.stringify({ versionId: UUID, expectedUpdatedAt: '2026-10-26T16:47:53.907461Z', cells: [] }).length;
    expect(MAX_SAVE_CELLS * widest + envelope).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect([MAX_SAVE_CELLS, MAX_IMPORT_CELLS]).toEqual([20_000, 100_000]);
  });
});
