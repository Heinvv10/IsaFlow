/**
 * Budgets P5-6: a holder whose rows name accounts sees those accounts and the headers above them,
 * with each header's child list cut to what is kept (gridHolderView.keepWithHeaders).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));

import { keepWithHeaders } from '@/modules/accounting/services/budgets/gridHolderView';
import type { GridAccount } from '@/modules/accounting/services/budgets/gridReadTypes';

const acct = (id: string, parentId: string | null, childIds: string[] = []): GridAccount => ({
  id, code: id, name: id, type: 'expense', subtype: null, band: 'opex' as GridAccount['band'], isActive: true, parentId, depth: parentId ? 1 : 0,
  isHeader: childIds.length > 0, childIds, ownAmounts: false, grain: null, rollup: null, note: null,
});

describe('keepWithHeaders', () => {
  const list = [acct('H', null, ['a', 'b']), acct('a', 'H'), acct('b', 'H'), acct('H2', null, ['c']), acct('c', 'H2'), acct('d', null)];
  it('keeps the allowed accounts and their headers; drops other children from the header', () => {
    const out = keepWithHeaders(list, new Set(['a', 'd']));
    expect(out.map((a) => a.id)).toEqual(['H', 'a', 'd']);
    expect(out.find((a) => a.id === 'H')!.childIds).toEqual(['a']);
  });
  it('matches ids case-insensitively (the server lower-cases the allowed set)', () => {
    expect(keepWithHeaders([acct('ABC', null)], new Set(['abc'])).map((a) => a.id)).toEqual(['ABC']);
  });
});
