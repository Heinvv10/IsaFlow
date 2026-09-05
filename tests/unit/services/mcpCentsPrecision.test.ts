import { describe, it, expect } from 'vitest';
import { hasWholeCents, MAX_MONEY } from '@/lib/mcp/tools/toolHelpers';
import { parseAllocations } from '@/lib/mcp/tools/cashApplicationArgs';

const INV = '11111111-1111-4111-8111-111111111111';

describe('hasWholeCents', () => {
  it('accepts cent amounts whose float product overshoots (the reload blocker)', () => {
    // 282543.34 * 100 === 28254334.000000004 in IEEE-754, so an
    // `amount * 100 !== Math.round(amount * 100)` test rejected a real receipt.
    expect(282543.34 * 100).not.toBe(Math.round(282543.34 * 100));
    expect(hasWholeCents(282543.34)).toBe(true);
  });

  it('accepts cent amounts at any magnitude', () => {
    for (const a of [0.01, 12.34, 1000000000000.55, 9999999999999.99]) {
      expect(hasWholeCents(a)).toBe(true);
    }
  });

  it('still rejects genuine sub-cent precision', () => {
    for (const a of [100.005, 12.345, 1.005, 0.1 + 0.2]) {
      expect(hasWholeCents(a)).toBe(false);
    }
  });

  it('handles negative amounts and -0 by the same rule', () => {
    expect(hasWholeCents(-5.5)).toBe(true);
    expect(hasWholeCents(-0)).toBe(true);
    expect(hasWholeCents(-5.555)).toBe(false);
  });

  it('rejects non-finite values rather than letting them reach the ledger', () => {
    for (const a of [NaN, Infinity, -Infinity]) {
      expect(hasWholeCents(a)).toBe(false);
    }
  });

  it('accepts the largest amount the column holds, and rejects one cent more', () => {
    expect(MAX_MONEY).toBe(9999999999999.99);
    expect(hasWholeCents(MAX_MONEY)).toBe(true);
    expect(hasWholeCents(-MAX_MONEY)).toBe(true);
    // 14 integer digits: representable as a double, overflows NUMERIC(15,2).
    expect(hasWholeCents(99999999999999.99)).toBe(false);
  });

  it('rejects 1e21, where toFixed goes exponential and the cents test alone passes', () => {
    // (1e21).toFixed(2) === '1e+21', which parses back equal — so without the
    // magnitude bound this value would be accepted and then 22003 mid-write.
    expect((1e21).toFixed(2)).toBe('1e+21');
    expect(Number((1e21).toFixed(2)) === 1e21).toBe(true);
    expect(hasWholeCents(1e21)).toBe(false);
    expect(hasWholeCents(Number.MAX_VALUE)).toBe(false);
  });
});

describe('parseAllocations cent precision', () => {
  it('accepts 282543.34', () => {
    const r = parseAllocations({ allocations: [{ invoice_id: INV, amount: 282543.34 }] }, 'invoice_id');
    expect(r.ok).toBe(true);
  });

  it('rejects a third decimal', () => {
    const r = parseAllocations({ allocations: [{ invoice_id: INV, amount: 100.005 }] }, 'invoice_id');
    expect(r.ok).toBe(false);
  });

  it('refuses an over-column amount BEFORE any write, not as a 22003 mid-write', () => {
    const r = parseAllocations({ allocations: [{ invoice_id: INV, amount: 1e21 }] }, 'invoice_id');
    expect(r.ok).toBe(false);
  });
});
