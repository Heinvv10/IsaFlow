/**
 * Rule A's reader (#1701 round 8 item 6): a linked note approved before migration 874 recorded no revenue-allocation
 * row; posting REPLAYS its subtotal against its own invoice's legs (invoiceRevenueLines.replayLegacyNotes), and what the
 * legs could not take is its excess. So it reverses what the replay took (creditNoteLegacyReplay), on its own invoice,
 * and only the rest is detached. (The gate fixer's version read the whole subtotal as reversed, so a 200 + 30 note on a
 * 100 invoice detached nothing and its excess counted nowhere.)
 */
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ takes: new Map<string, number>() }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/creditNoteLegacyReplay', () => ({ legacyReplayTakes: vi.fn(async () => h.takes) }));

import { sql } from '@/lib/neon';
import { detachedProfiles } from '@/modules/accounting/services/ar/creditNoteDetachedRead';
import { detachedCounts } from '@/modules/accounting/services/ar/creditNoteDetached';
import { legacyReplayTakes } from '@/modules/accounting/services/ar/creditNoteLegacyReplay';

const row = (over: Record<string, unknown>) => ({
  id: 'n1', linked: null, recorded: false, total_cents: '23000', subtotal_cents: '20000', reversed_cents: '0', reversed_on: [],
  applications: [['typed-inv', '11500']], ...over,
});

describe('detachedProfiles and a note approved before 874', () => {
  it('wholly taken by the replay (100 + 15 on a 100 invoice): reversed there, detaches nothing', async () => {
    h.takes = new Map([['n1', 10000]]);
    vi.mocked(sql).mockResolvedValueOnce([row({ linked: 'legacy-inv', total_cents: '11500', subtotal_cents: '10000' })] as never);
    const p = (await detachedProfiles('co', ['n1'])).get('n1')!;
    expect(p).toMatchObject({ detached: 0, reversedOn: ['legacy-inv'] });
    expect(detachedCounts(p).get('typed-inv')).toBe(0);
    expect(legacyReplayTakes).toHaveBeenCalledWith('co', 'legacy-inv');
  });
  it('200 + 30 on a 100 invoice: the replay took 100, so 115 is detached and counts on the typed invoice', async () => {
    h.takes = new Map([['n1', 10000]]);
    vi.mocked(sql).mockResolvedValueOnce([row({ linked: 'legacy-inv' })] as never);
    const p = (await detachedProfiles('co', ['n1'])).get('n1')!;
    expect(p).toMatchObject({ detached: 11500, reversedOn: ['legacy-inv'] });
    expect(detachedCounts(p).get('typed-inv')).toBe(11500);
  });
  it('a recorded note (it has allocation rows) is read from its rows, never replayed; an unlinked one is wholly detached', async () => {
    vi.mocked(legacyReplayTakes).mockClear();
    vi.mocked(sql).mockResolvedValueOnce([row({ linked: 'x', recorded: true, reversed_cents: '20000', reversed_on: ['x'] }), row({ id: 'n2' })] as never);
    const ps = await detachedProfiles('co', ['n1', 'n2']);
    expect(ps.get('n1')).toMatchObject({ detached: 0, reversedOn: ['x'] });
    expect(ps.get('n2')).toMatchObject({ detached: 23000, reversedOn: [] });
    expect(legacyReplayTakes).not.toHaveBeenCalled();
  });
});
