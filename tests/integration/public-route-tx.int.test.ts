/**
 * withPublicRouteTransaction — the transaction wrapper the two public Paystack
 * routes run in. Two hazards from the K-035/K-036 review are proved here
 * against a real database:
 *   - a ROLLBACK that itself fails must DESTROY the connection, not hand an
 *     aborted transaction back to the pool for the next request to inherit;
 *   - nesting it inside an existing request transaction must be refused rather
 *     than silently shadowing that request's ALS context.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();

import { withPublicRouteTransaction } from '@/lib/publicRouteTx';
import { getDbPool, sql } from '@/lib/neon';
import { als } from '@/lib/als';

const killer = new Pool({ connectionString: process.env.DATABASE_URL });

afterAll(async () => {
  await killer.end();
});

describe('withPublicRouteTransaction', () => {
  it('commits the work and returns the connection to the pool', async () => {
    const value = await withPublicRouteTransaction('ok', async () => {
      const rows = await sql<{ n: number }>`SELECT 1::int AS n`;
      return rows[0]!.n;
    });
    expect(value).toBe(1);
  });

  it('keeps the connection reusable when the body throws but ROLLBACK succeeds', async () => {
    await expect(
      withPublicRouteTransaction('business-failure', async () => {
        await sql`SELECT 1`;
        throw new Error('business failure');
      }),
    ).rejects.toThrow('business failure');

    // A clean rollback leaves a perfectly good connection; the pool keeps it.
    expect(getDbPool().idleCount).toBeGreaterThan(0);
    const rows = await sql<{ n: number }>`SELECT 2::int AS n`;
    expect(rows[0]!.n).toBe(2);
  });

  it('destroys the connection when the ROLLBACK itself fails', async () => {
    await expect(
      withPublicRouteTransaction('dead-connection', async () => {
        const pidRows = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`;
        // Kill the very backend this transaction is running on, so the
        // ROLLBACK in the catch cannot succeed.
        await killer.query('SELECT pg_terminate_backend($1)', [pidRows[0]!.pid]);
        throw new Error('boom');
      }),
    ).rejects.toThrow();

    // Released with an error, so pg discards it rather than pooling a client
    // whose transaction state is unknown.
    expect(getDbPool().idleCount).toBe(0);
    // And the pool still serves the next caller.
    const rows = await sql<{ n: number }>`SELECT 3::int AS n`;
    expect(rows[0]!.n).toBe(3);
  });

  it('refuses to nest inside an existing request transaction', async () => {
    const client = await getDbPool().connect();
    try {
      await client.query('BEGIN');
      await expect(
        als.run({ client, userId: '', companyId: '', claims: {} }, () =>
          withPublicRouteTransaction('nested', async () => 'never'),
        ),
      ).rejects.toThrow(/called inside an existing request transaction/);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});
