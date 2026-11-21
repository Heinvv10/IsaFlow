/**
 * Rule A's reader (#1701 review round 8): a linked note approved before migration 874 recorded no revenue-allocation
 * row, and the posting replays its whole subtotal on its own invoice. It must not read as wholly detached, or its
 * on-account balance applied to a typed invoice would use that invoice's capacity a second time.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));

import { sql } from '@/lib/neon';
import { detachedProfiles } from '@/modules/accounting/services/ar/creditNoteDetachedRead';
import { detachedCounts } from '@/modules/accounting/services/ar/creditNoteDetached';

const row = (over: Record<string, unknown>) => ({
  id: 'n1', total_cents: '23000', subtotal_cents: '20000', reversed_cents: '0', reversed_on: [], replayed_on: null,
  applications: [['typed-inv', '11500']], ...over,
});

describe('detachedProfiles', () => {
  it('a pre-874 linked note: reversed its subtotal on its own invoice, so detaches nothing', async () => {
    vi.mocked(sql).mockResolvedValueOnce([row({ replayed_on: 'legacy-inv' })] as never);
    const p = (await detachedProfiles('co', ['n1'])).get('n1')!;
    expect(p).toMatchObject({ detached: 0, reversedOn: ['legacy-inv'] });
    expect(detachedCounts(p).get('typed-inv')).toBe(0);
  });

  it('an unlinked note with no row: wholly detached, its application counts', async () => {
    vi.mocked(sql).mockResolvedValueOnce([row({})] as never);
    const p = (await detachedProfiles('co', ['n1'])).get('n1')!;
    expect(p).toMatchObject({ detached: 23000, reversedOn: [] });
    expect(detachedCounts(p).get('typed-inv')).toBe(11500);
  });
});
