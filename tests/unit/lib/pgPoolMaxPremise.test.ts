/**
 * R-182 premise, pinned against the REAL pg-pool (nothing mocked) so the docs
 * cannot drift from the library: NaN and 0 become 10; a negative `max` is kept
 * and the pool is then always "full", so it never opens a connection; Infinity
 * is kept (no limit). This is why poolSizeFromEnv refuses those values.
 */
import { describe, expect, it } from 'vitest';
import Pool from 'pg-pool';

let opened = 0;
class FakeClient {
  connect(cb: (err?: Error) => void): void { opened += 1; cb(); }
  on(): this { return this; }
  removeListener(): this { return this; }
  end(): void { /* nothing to close */ }
}

const build = (max: number) => new Pool({ max, Client: FakeClient as never, connectionTimeoutMillis: 50 });

describe('pg-pool max handling (R-182 premise)', () => {
  it.each([[NaN], [0]])('turns max %j into 10, not unbounded', (max) => {
    expect(build(max).options.max).toBe(10);
  });

  it('keeps Infinity (no limit)', () => {
    expect(build(Infinity).options.max).toBe(Infinity);
  });

  it('keeps a negative max, and the pool then never opens a connection', async () => {
    opened = 0;
    const pool = build(-1);
    expect(pool.options.max).toBe(-1);
    await expect(pool.connect()).rejects.toThrow(/timeout/i);
    expect(opened).toBe(0);
  });

  it('a positive max does open connections', async () => {
    opened = 0;
    const client = await build(2).connect();
    client.release();
    expect(opened).toBe(1);
  });
});
