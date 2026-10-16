/**
 * Migration 894: companies.entity_type holds one of the eight SA entity codes
 * (src/lib/entityTypes.ts). The CHECK refuses anything else; the migration turns
 * 408's 'pty' (and a legacy 'company' or NULL) into 'pty_ltd' and keeps cc/trust.
 *
 * Disposable schema fixture only (assertDisposable). The conversion case
 * re-creates the pre-894 state inside a transaction, runs the migration file,
 * and rolls back.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { ENTITY_TYPE_CODES } from '@/lib/entityTypes';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const ids: string[] = [];
const MIGRATION = readFileSync('scripts/migrations/sql/894_company_entity_type_sa_codes.sql', 'utf8');

async function insertCompany(entityType?: string | null): Promise<string> {
  const id = crypto.randomUUID();
  ids.push(id);
  if (entityType === undefined) {
    await pool.query('INSERT INTO companies (id, name, created_at) VALUES ($1, $2, NOW())', [id, `ET894 ${id}`]);
  } else {
    await pool.query('INSERT INTO companies (id, name, entity_type, created_at) VALUES ($1, $2, $3, NOW())',
      [id, `ET894 ${id}`, entityType]);
  }
  return id;
}

async function sqlstate(p: Promise<unknown>): Promise<string | undefined> {
  return p.then(() => undefined, (e: { code?: string }) => e.code);
}

beforeAll(async () => { await pool.query('SELECT 1'); });
afterAll(async () => {
  try {
    if (ids.length) await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [ids]);
  } finally {
    await pool.end();
  }
});

describe('migration 894: companies.entity_type CHECK on the eight SA codes', () => {
  it('accepts each of the eight codes and defaults a new company to pty_ltd', async () => {
    for (const code of ENTITY_TYPE_CODES) {
      const id = await insertCompany(code);
      const row = (await pool.query('SELECT entity_type FROM companies WHERE id = $1', [id])).rows[0];
      expect(row.entity_type).toBe(code);
    }
    const dflt = await insertCompany();
    expect((await pool.query('SELECT entity_type FROM companies WHERE id = $1', [dflt])).rows[0].entity_type)
      .toBe('pty_ltd');
  });

  it("refuses an unknown code, 408's 'pty' and the legacy 'company' (23514)", async () => {
    for (const bad of ['bogus', 'pty', 'company', 'Pty_Ltd', '']) {
      expect(await sqlstate(insertCompany(bad)), bad).toBe('23514');
    }
    const id = await insertCompany('cc');
    expect(await sqlstate(pool.query("UPDATE companies SET entity_type = 'pty' WHERE id = $1", [id]))).toBe('23514');
  });

  it("converts pty/company/NULL to pty_ltd, keeps cc and trust, and validates", async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      // The pre-894 state: 408's CHECK gone (a legacy 'company' predates it), default 'pty'.
      await c.query('ALTER TABLE companies DROP CONSTRAINT companies_entity_type_check');
      await c.query("ALTER TABLE companies ALTER COLUMN entity_type SET DEFAULT 'pty'");
      await c.query('ALTER TABLE companies ALTER COLUMN entity_type DROP NOT NULL');
      const rows: Record<string, string | null> = { pty: 'pty', company: 'company', cc: 'cc', trust: 'trust', nul: null };
      const made: Record<string, string> = {};
      for (const [k, v] of Object.entries(rows)) {
        const id = crypto.randomUUID();
        made[k] = id;
        await c.query('INSERT INTO companies (id, name, entity_type, created_at) VALUES ($1, $2, $3, NOW())',
          [id, `ET894-mig ${id}`, v]);
      }
      await c.query(MIGRATION);
      const got = (await c.query('SELECT id, entity_type FROM companies WHERE id = ANY($1::uuid[])',
        [Object.values(made)])).rows as { id: string; entity_type: string }[];
      const by = Object.fromEntries(got.map(r => [r.id, r.entity_type]));
      expect(by[made.pty!]).toBe('pty_ltd');
      expect(by[made.company!]).toBe('pty_ltd');
      expect(by[made.nul!]).toBe('pty_ltd');
      expect(by[made.cc!]).toBe('cc');
      expect(by[made.trust!]).toBe('trust');
      const con = (await c.query(`SELECT convalidated, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'public.companies'::regclass AND conname = 'companies_entity_type_check'`)).rows[0];
      expect(con.convalidated).toBe(true);
      for (const code of ENTITY_TYPE_CODES) expect(con.def).toContain(`'${code}'`);
      expect(con.def).not.toContain("'pty'::");
      const dflt = (await c.query(`SELECT column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'companies' AND column_name = 'entity_type'`)).rows[0];
      expect(dflt.column_default).toBe("'pty_ltd'::text");
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});
