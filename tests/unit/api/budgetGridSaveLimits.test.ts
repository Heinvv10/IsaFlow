/**
 * The save route's body limits, pinned to the arithmetic in its comment (round 8): 18 MB holds the
 * largest save (100 000 widest cells, ~17.2 MB); the total stays under Node's 300 s request
 * timeout; and a real 512 kbit/s ADSL line (~54 000 B/s) delivers at least 14 MB in it. The worst
 * commit does not fit on such a line, which is why the grid client splits commits over ~14 MB.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
import { SAVE_BODY_LIMITS } from '../../../pages/api/accounting/budget-grid/save';
import { MAX_SAVE_CELLS } from '@/modules/accounting/services/budgets/gridSaveValidate';

const MB = 1048576;
const ADSL_BYTES_PER_SEC = 54_000;

describe('budget-grid save body limits', () => {
  it('are pinned whole', () => {
    expect(SAVE_BODY_LIMITS).toEqual({ maxBytes: 18 * MB, totalMs: 290_000, idleMs: 10_000 });
  });

  it('hold the largest save, stay under the 300 s request timeout, and carry 14 MB over real ADSL', () => {
    const largestBody = MAX_SAVE_CELLS * 172; // bytes: the widest compact cell, as documented
    expect(largestBody).toBeLessThanOrEqual(SAVE_BODY_LIMITS.maxBytes);
    expect(SAVE_BODY_LIMITS.totalMs).toBeLessThan(300_000);
    expect((SAVE_BODY_LIMITS.totalMs / 1000) * ADSL_BYTES_PER_SEC).toBeGreaterThanOrEqual(14 * MB);
    // The worst commit does not fit on that line: the client splits it (documented in save.ts).
    expect((largestBody / ADSL_BYTES_PER_SEC) * 1000).toBeGreaterThan(SAVE_BODY_LIMITS.totalMs);
  });
});
