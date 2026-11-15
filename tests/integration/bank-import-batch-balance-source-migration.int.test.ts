/**
 * WP1 PR-A review round 3: migration 998 always ends with the five-value balance_source CHECK, on a re-run and on a
 * database that applied an earlier draft of 998 (four values, no 'ai_read'): it drops the constraint if present and
 * adds it again NOT VALID, then validates. Run here as the runner runs a file (applyOne: one transaction per file).
 */
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
afterAll(async () => { await pool.end(); });

const FILE = readFileSync('scripts/migrations/sql/998_bank_import_batch_balance_source.sql', 'utf8');
const NAME = 'bank_import_batches_balance_source_ck';
const FIVE = ['ai_read', 'not_in_file', 'printed', 'running_balance', 'unverified'];

async function applyFile(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(FILE);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }
}

/** The values the CHECK allows, and whether it is validated. */
async function check(): Promise<{ values: string[]; validated: boolean }> {
  const { rows } = await pool.query(
    `SELECT pg_get_constraintdef(oid) AS def, convalidated FROM pg_constraint
     WHERE conname = $1 AND conrelid = 'bank_import_batches'::regclass`, [NAME]);
  expect(rows).toHaveLength(1);
  return { values: [...String(rows[0].def).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!).sort(), validated: rows[0].convalidated };
}

describe('migration 998: the balance_source CHECK', () => {
  it('re-running the file keeps exactly the five-value, validated CHECK', async () => {
    await applyFile();
    await applyFile();
    expect(await check()).toEqual({ values: FIVE, validated: true });
  });

  it('replaces an earlier four-value CHECK (a database that applied the first draft of 998)', async () => {
    await pool.query(`ALTER TABLE bank_import_batches DROP CONSTRAINT IF EXISTS ${NAME}`);
    await pool.query(`ALTER TABLE bank_import_batches ADD CONSTRAINT ${NAME}
      CHECK (balance_source IS NULL OR balance_source IN ('printed','running_balance','not_in_file','unverified'))`);
    await applyFile();
    expect(await check()).toEqual({ values: FIVE, validated: true });
  });
});
