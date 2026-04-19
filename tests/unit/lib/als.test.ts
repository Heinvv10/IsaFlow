// tests/unit/lib/als.test.ts
import { describe, it, expect } from 'vitest';
import type { PoolClient } from 'pg';
import { als, requireCtx } from '@/lib/als';

// A typed stand-in for PoolClient so tests don't pull in pg runtime.
const fakeClient = null as unknown as PoolClient;

describe('als', () => {
  it('isolates context between concurrent async operations', async () => {
    const ctxA = { client: fakeClient, userId: 'A', companyId: 'cA', claims: {} };
    const ctxB = { client: fakeClient, userId: 'B', companyId: 'cB', claims: {} };

    const runInCtx = async (ctx: typeof ctxA, delay: number) =>
      als.run(ctx, async () => {
        await new Promise((r) => setTimeout(r, delay));
        return requireCtx().userId;
      });

    const [a, b] = await Promise.all([runInCtx(ctxA, 10), runInCtx(ctxB, 5)]);
    expect(a).toBe('A');
    expect(b).toBe('B');
  });

  it('throws when requireCtx() is called outside any als.run scope', () => {
    expect(() => requireCtx()).toThrow(/no request context/);
  });

  it('returns undefined from als.getStore() outside any run', () => {
    expect(als.getStore()).toBeUndefined();
  });

  it('allows companyId to be omitted (platform-admin case)', async () => {
    // Type guard: if this stops compiling, companyId was made required again.
    await als.run(
      { client: fakeClient, userId: 'u1', claims: {} },
      async () => {
        const ctx = als.getStore()!;
        expect(ctx.userId).toBe('u1');
        expect(ctx.companyId).toBeUndefined();
      }
    );
  });
});
