/**
 * The pair this file proves: `vitest.config.ts`'s DATABASE_URL fallback and
 * `isDbReachable`'s short-circuit only work together because they agree on
 * the substring `dummy` — undeclared at both ends. Found by the adversarial
 * reviewer on the seed branch while checking something else.
 *
 * `describe.skipIf(!process.env.DATABASE_URL)` is NOT the guard — the same
 * round established that vitest.config.ts injects DATABASE_URL into
 * `test.env` unconditionally (real value, or this fallback), so unsetting
 * the env var before running vitest changes nothing a test sees.
 * `isDbReachable()` is the only thing that actually decides whether a
 * DB-backed test runs, and it decides by checking for `dummy` in the URL.
 *
 * If someone "tidies" the fallback in vitest.config.ts to look like a real
 * connection string, `isDbReachable` stops short-circuiting: instead of an
 * instant skip, every DB-gated test in the suite pays a real connection
 * attempt per call. Not a wrong answer — the tests still skip, once the
 * attempt resolves — but the coupling that makes it FAST is invisible from
 * either file alone. This test fails at the moment of that edit.
 *
 * ASSERTS ON THE MECHANISM (whether `pg.Client.connect` was called at all),
 * not on elapsed time. A local Postgres listening on the mutated fallback's
 * port can reject a bad password FAST, which made a timing-based version of
 * this test pass right through the exact mutation it existed to catch —
 * caught only by actually breaking it and watching, per CONTRACTS.md's
 * evidence rule.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const originalDatabaseUrl = process.env.DATABASE_URL;
let connectMock: ReturnType<typeof vi.fn>;

function readConfigFallback(): string {
  const configSrc = readFileSync(join(process.cwd(), 'vitest.config.ts'), 'utf8');
  const m = /DATABASE_URL:\s*env\['DATABASE_URL'\]\s*\?\?\s*'([^']+)'/.exec(configSrc);
  if (!m?.[1]) {
    throw new Error(
      'vitest.config.ts no longer has a DATABASE_URL fallback in the expected shape — ' +
      'this test and dbReachable.ts both assume one exists and contains "dummy"',
    );
  }
  return m[1];
}

beforeEach(() => {
  vi.resetModules();
  connectMock = vi.fn().mockResolvedValue(undefined);
  class FakeClient {
    connect = connectMock;
    query = vi.fn().mockResolvedValue({ rows: [] });
    end = vi.fn().mockResolvedValue(undefined);
  }
  vi.doMock('pg', () => ({ Client: FakeClient }));
});

afterEach(() => {
  vi.doUnmock('pg');
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

describe('vitest.config.ts DATABASE_URL fallback <-> dbReachable.ts short-circuit', () => {
  it('the config fallback literal is read out of vitest.config.ts, not paraphrased here, and contains "dummy"', () => {
    expect(readConfigFallback()).toContain('dummy');
  });

  it('isDbReachable() makes NO connection attempt on the EXACT fallback vitest.config.ts uses', async () => {
    process.env.DATABASE_URL = readConfigFallback();
    const { isDbReachable } = await import('./dbReachable');

    const reachable = await isDbReachable();

    expect(reachable).toBe(false);
    expect(connectMock).not.toHaveBeenCalled();
  });

  it('control: isDbReachable() DOES attempt a connection for a URL without the sentinel — proves the mock and the previous test are not both vacuous', async () => {
    process.env.DATABASE_URL = 'postgresql://real:real@localhost:5432/test';
    const { isDbReachable } = await import('./dbReachable');

    await isDbReachable();

    expect(connectMock).toHaveBeenCalledTimes(1);
  });
});
