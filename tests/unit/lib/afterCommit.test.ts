/**
 * R-075 — a request's connection must not outlive the request.
 *
 * Once the owner of a request context (withAuth, the bearer pipeline, …) has
 * finished its handler, it COMMITs and releases the client to its pool, where
 * the next request is handed the same connection. Two halves are pinned here:
 *   1. neon.ts REFUSES to route a query through a finished context, on every
 *      path that reaches the request client, instead of silently running it in
 *      whatever transaction now holds that connection;
 *   2. work that must outlive the request goes through runAfterCommit: queued
 *      on the context, started only when the owner drains it after COMMIT, and
 *      run with no ALS store so its queries take their own connection.
 * The real AsyncLocalStorage is used, entered with a scripted client.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { logError } = vi.hoisted(() => ({ logError: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: logError, debug: vi.fn() } }));

import { sql, withSavepoint, withTransaction } from '@/lib/neon';
import { als, type RequestContext } from '@/lib/als';
import { drainAfterCommit, runAfterCommit, runOwnedContext } from '@/lib/afterCommit';

function makeCtx(extra: Partial<RequestContext> = {}) {
  const query = vi.fn(async () => ({ rows: [{ ok: 1 }] }));
  const ctx = { client: { query }, userId: 'u1', companyId: 'c1', claims: {}, ...extra } as unknown as RequestContext;
  return { ctx, query };
}

beforeEach(() => logError.mockReset());

describe('neon.ts refuses a finished request context', () => {
  const paths: Array<[string, () => Promise<unknown>]> = [
    ['sql tagged template', async () => sql`SELECT 1`],
    ['sql.transaction', () => sql.transaction([sql`SELECT 1`])],
    ['withTransaction', () => withTransaction(async (tx) => tx`SELECT 1`)],
    ['withSavepoint', () => withSavepoint('sp_r075', async () => sql`SELECT 1`)],
  ];
  for (const [name, run] of paths) {
    it(`${name}: throws naming the cause and never touches the released client`, async () => {
      const { ctx, query } = makeCtx({ finished: true });
      await als.run(ctx, async () => {
        await expect(run()).rejects.toThrow(/already finished and its connection was released/);
      });
      expect(query).not.toHaveBeenCalled();
    });
  }

  it('the legitimate path — a query while the owner is still running — is unaffected', async () => {
    const { ctx, query } = makeCtx({ afterCommit: [] });
    const rows = await runOwnedContext(ctx, async () => sql`SELECT 1`);
    expect(rows).toEqual([{ ok: 1 }]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('runOwnedContext finishes the context, so a query a leaked promise issues later is refused', async () => {
    const { ctx, query } = makeCtx({ afterCommit: [] });
    let leaked: Promise<unknown> | undefined;
    const gate = Promise.resolve();
    await runOwnedContext(ctx, async () => {
      leaked = gate.then(() => new Promise((r) => setTimeout(r, 5))).then(() => sql`SELECT 1`);
    });
    expect(ctx.finished).toBe(true);
    await expect(leaked).rejects.toThrow(/already finished/);
    expect(query).not.toHaveBeenCalled();
  });

  it('runOwnedContext finishes the context even when the handler throws', async () => {
    const { ctx } = makeCtx();
    await expect(runOwnedContext(ctx, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(ctx.finished).toBe(true);
  });
});

describe('runAfterCommit', () => {
  it('queues inside a request and starts nothing until the owner drains', async () => {
    const { ctx } = makeCtx({ afterCommit: [] });
    const fn = vi.fn(async () => undefined);
    await runOwnedContext(ctx, async () => { runAfterCommit('queued', fn); });
    await new Promise((r) => setTimeout(r, 5));
    expect(fn).not.toHaveBeenCalled();
    expect(ctx.afterCommit).toHaveLength(1);
  });

  it('drained work runs with no ALS store, so its queries cannot reach the request client', async () => {
    const { ctx } = makeCtx({ afterCommit: [] });
    const seen: Array<RequestContext | undefined> = [];
    await runOwnedContext(ctx, async () => {
      runAfterCommit('probe', async () => {
        seen.push(als.getStore());
        await Promise.resolve();
        seen.push(als.getStore());
      });
    });
    // Drained from inside ANOTHER context, as a nested owner might: still none.
    const { ctx: outer } = makeCtx();
    await als.run(outer, async () => { drainAfterCommit(ctx); });
    await new Promise((r) => setTimeout(r, 5));
    expect(seen).toEqual([undefined, undefined]);
    expect(ctx.afterCommit).toBeUndefined();
  });

  it('a failing callback is logged, never thrown into the drain', async () => {
    const { ctx } = makeCtx({ afterCommit: [] });
    await runOwnedContext(ctx, async () => {
      runAfterCommit('rejects', async () => { throw new Error('vlm down'); });
      runAfterCommit('throws sync', (() => { throw new Error('sync boom'); }) as () => Promise<unknown>);
    });
    expect(() => drainAfterCommit(ctx)).not.toThrow();
    await new Promise((r) => setTimeout(r, 5));
    expect(logError).toHaveBeenCalledWith('after-commit work failed', { label: 'rejects', error: 'vlm down' }, 'DB');
    expect(logError).toHaveBeenCalledWith('after-commit work failed', { label: 'throws sync', error: 'sync boom' }, 'DB');
  });

  it('refuses a context whose owner does not drain, rather than dropping the work', async () => {
    const { ctx } = makeCtx();
    await als.run(ctx, async () => {
      expect(() => runAfterCommit('orphan', async () => undefined)).toThrow(/owner does not run after-commit work/);
    });
  });

  it('refuses a finished context', async () => {
    const { ctx } = makeCtx({ afterCommit: [], finished: true });
    await als.run(ctx, async () => {
      expect(() => runAfterCommit('late', async () => undefined)).toThrow(/already finished/);
    });
  });

  it('outside any request there is nothing to wait for: it starts immediately', async () => {
    const fn = vi.fn(async () => undefined);
    runAfterCommit('no store', fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
