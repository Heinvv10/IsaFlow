/** Migration 894 edge cases (edge-case repros from the PR A review). Disposable fixture only. */
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const MIGRATION = readFileSync('scripts/migrations/sql/894_company_entity_type_sa_codes.sql', 'utf8');
afterAll(async () => { await pool.end(); });

describe('894 edges', () => {
  it('an explicit NULL entity_type is refused (NOT NULL, 23502)', async () => {
    const id = crypto.randomUUID();
    await expect(pool.query('INSERT INTO companies (id,name,entity_type,created_at) VALUES ($1,$2,NULL,NOW())',
      [id, `E ${id}`])).rejects.toMatchObject({ code: '23502' });
  });

  it('migration is idempotent: running it twice in a row succeeds and leaves data unchanged', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const id = crypto.randomUUID();
      await c.query("INSERT INTO companies (id,name,entity_type,created_at) VALUES ($1,$2,'ltd',NOW())", [id, `E ${id}`]);
      await c.query(MIGRATION); await c.query(MIGRATION);
      expect((await c.query('SELECT entity_type FROM companies WHERE id=$1', [id])).rows[0].entity_type).toBe('ltd');
    } finally { await c.query('ROLLBACK'); c.release(); }
  });

  it('migration with an unknown legacy value (e.g. "sole_prop") fails loudly, not silently', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('ALTER TABLE companies DROP CONSTRAINT companies_entity_type_check');
      const id = crypto.randomUUID();
      await c.query("INSERT INTO companies (id,name,entity_type,created_at) VALUES ($1,$2,'Pty',NOW())", [id, `E ${id}`]);
      await expect(c.query(MIGRATION)).rejects.toMatchObject({ code: '23514' });
    } finally { await c.query('ROLLBACK'); c.release(); }
  });

  it('migration: rows with a NULL entity_type are converted and the column ends NOT NULL', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('ALTER TABLE companies DROP CONSTRAINT companies_entity_type_check');
      await c.query('ALTER TABLE companies ALTER COLUMN entity_type DROP NOT NULL');
      const id = crypto.randomUUID();
      await c.query("INSERT INTO companies (id,name,entity_type,created_at) VALUES ($1,$2,NULL,NOW())", [id, `E ${id}`]);
      await c.query(MIGRATION);
      expect((await c.query('SELECT count(*)::int n FROM companies WHERE entity_type IS NULL')).rows[0].n).toBe(0);
      expect((await c.query(`SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public'
        AND table_name = 'companies' AND column_name = 'entity_type'`)).rows[0].is_nullable).toBe('NO');
    } finally { await c.query('ROLLBACK'); c.release(); }
  });
});
