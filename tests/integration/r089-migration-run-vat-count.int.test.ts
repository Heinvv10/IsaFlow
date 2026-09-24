/**
 * R-089 — the "VAT not stated" count survives the round trip to the migration
 * history, on real PostgreSQL. `completeRun` writes it into
 * gl_migration_runs.details and `getMigrationStatus` reads it back for the
 * Sage migration page; neither half was covered by a test (review round 4).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';
import {
  startRun, completeRun, getMigrationStatus,
} from '@/modules/accounting/services/core/sageMigrationService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const company = randomUUID();
const user = randomUUID();

async function inTx<T>(fn: () => Promise<T>): Promise<T> {
  const c = await pool.connect();
  await c.query('BEGIN');
  try {
    const out = await als.run({ client: c, userId: user, companyId: company, claims: {} } as never, fn);
    await c.query('COMMIT');
    return out;
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'R089 run count']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM gl_migration_runs WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

describe('R-089: the vatNotStated count reaches the migration history', () => {
  it('is written by completeRun and read back by getMigrationStatus', async () => {
    const run = await inTx(async () => {
      const runId = await startRun('invoice_import', user, company);
      return completeRun(runId, company, 5, 4, 0, 1, 3);
    });
    expect(run.vatNotStated).toBe(3);

    const status = await inTx(() => getMigrationStatus(company));
    const last = status.lastRuns.find((r) => r.id === run.id);
    expect(last?.vatNotStated).toBe(3);
  });
});
