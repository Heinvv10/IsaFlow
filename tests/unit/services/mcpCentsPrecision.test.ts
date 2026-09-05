import { describe, it, expect } from 'vitest';
import { hasWholeCents } from '@/lib/mcp/tools/toolHelpers';
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
});
