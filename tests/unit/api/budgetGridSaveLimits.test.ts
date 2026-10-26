/**
 * The save route's body limits, pinned to the arithmetic in its comment (round 7): the largest save
 * (100 000 widest cells, ~17.2 MB) must fit in 18 MB and arrive within the total over a 512 kbit/s
 * ADSL uplink (62.5 KiB/s, ~282 s), and the total must stay under Node's 300 s request timeout.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
import { SAVE_BODY_LIMITS } from '../../../pages/api/accounting/budget-grid/save';
import { MAX_SAVE_CELLS } from '@/modules/accounting/services/budgets/gridSaveValidate';

describe('budget-grid save body limits', () => {
  it('fit the largest save over 512 kbit/s ADSL and stay under the 300 s request timeout', () => {
    const largestBody = MAX_SAVE_CELLS * 172; // bytes: the widest compact cell, as documented
    const adslBytesPerSec = 512_000 / 8;
    expect(largestBody).toBeLessThanOrEqual(SAVE_BODY_LIMITS.maxBytes);
    expect(SAVE_BODY_LIMITS.totalMs).toBeGreaterThanOrEqual(Math.ceil((largestBody / adslBytesPerSec) * 1000));
    expect(SAVE_BODY_LIMITS.totalMs).toBeLessThan(300_000);
    // Pinned: 290 s also covers 17.2 MiB at 62.5 KiB/s (~282 s), the review's reading of the same figure.
    expect(SAVE_BODY_LIMITS.totalMs).toBe(290_000);
  });
});
