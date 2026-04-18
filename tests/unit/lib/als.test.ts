// tests/unit/lib/als.test.ts
import { describe, it, expect } from 'vitest';
import { als, requireCtx } from '@/lib/als';

describe('als', () => {
  it('isolates context between sibling async operations', async () => {
    const ctxA = { client: null as any, userId: 'A', companyId: 'cA', claims: {} };
    const ctxB = { client: null as any, userId: 'B', companyId: 'cB', claims: {} };

    const runInCtx = async (ctx: typeof ctxA, delay: number) =>
      als.run(ctx, async () => {
        await new Promise((r) => setTimeout(r, delay));
        return requireCtx().userId;
      });

    const [a, b] = await Promise.all([runInCtx(ctxA, 10), runInCtx(ctxB, 5)]);
    expect(a).toBe('A');
    expect(b).toBe('B');
  });

  it('throws when requireCtx() called outside an als.run scope', () => {
    expect(() => requireCtx()).toThrow(/no request context/);
  });

  it('returns undefined from als.getStore() outside any run', () => {
    expect(als.getStore()).toBeUndefined();
  });
});
