/**
 * The lazy tagged-template query and the template-to-$N builder that every
 * query path shares.
 *
 * Part of `@/lib/neon` (R-184 split the former 475-line src/lib/neon.ts). Import
 * it ONLY from the barrel src/lib/neon.ts and its sibling modules: every other
 * file imports '@/lib/neon', which is what `vi.mock('@/lib/neon', ...)`
 * intercepts (guarded by tests/unit/lib/neonModuleShape.test.ts).
 */

import type pg from 'pg';
// Static, not an `await import`: assertTxUsable
// must be synchronous, and it lives in als.ts because the flag it reads is on
// RequestContext — keeping it there also keeps it out of every test's
// `vi.mock('@/lib/neon')`. Safe: als.ts imports only node:async_hooks,
// @/lib/logger and pg types, so there is no cycle back to this module.
import { als, assertTxUsable } from '@/lib/als';
import { getPool } from './pool';

// Matches the shape the Neon driver returned to the rest of the codebase —
// `NeonQueryFunction<false, false>` yields `Record<string, any>[]`. Keeping
// `any` for values preserves existing call-site ergonomics; tighten per-row
// types by parameterising `sql<Row>\`...\`` where it matters.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DbRow = Record<string, any>;

/**
 * Lazy result of a tagged-template call. Awaiting it runs the query against
 * the module-level pool; collecting many into an array and handing them to
 * `sql.transaction([...])` runs them atomically on a single tx client.
 */
export class LazyQuery<T = DbRow> implements Promise<T[]> {
  readonly [Symbol.toStringTag] = 'LazyQuery';

  constructor(
    public readonly text: string,
    public readonly values: unknown[],
    private readonly boundClient?: pg.PoolClient
  ) {}

  private async run(): Promise<T[]> {
    if (this.boundClient) {
      const res = await this.boundClient.query(this.text, this.values);
      return res.rows as T[];
    }
    // If a request-scoped tx is in flight, route through it so RLS sees the GUCs.
    const ctxClient = als.getStore()?.client;
    if (ctxClient) {
      // A savepoint rollback may have aborted this connection. Fail with the
      // ORIGINAL cause rather than the bare 25P02 pg would answer with.
      assertTxUsable();
      const res = await ctxClient.query(this.text, this.values);
      return res.rows as T[];
    }
    const res = await getPool().query(this.text, this.values);
    return res.rows as T[];
  }

  then<TResult1 = T[], TResult2 = never>(
    onfulfilled?: ((value: T[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.run().then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null
  ): Promise<T[] | TResult> {
    return this.run().catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<T[]> {
    return this.run().finally(onfinally);
  }
}

/**
 * Build a parameterised query from a tagged-template call. Interpolated
 * `LazyQuery` values (from `sql\`nested\`` or `sql.unsafe(raw)`) are spliced
 * in as raw fragments with their own `$N` placeholders renumbered to sit
 * alongside the surrounding query's parameters.
 */
export function buildQuery(
  strings: TemplateStringsArray,
  values: unknown[]
): { text: string; values: unknown[] } {
  let text = '';
  const params: unknown[] = [];
  for (let i = 0; i < strings.length; i++) {
    text += strings[i];
    if (i < values.length) {
      const v = values[i];
      if (v instanceof LazyQuery) {
        const offset = params.length;
        const renumbered = v.text.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + offset}`);
        text += renumbered;
        params.push(...v.values);
      } else {
        params.push(v);
        text += `$${params.length}`;
      }
    }
  }
  return { text, values: params };
}
