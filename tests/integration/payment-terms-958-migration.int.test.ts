/**
 * Migration 958 (payment terms, the EXPAND half) against every legacy shape a contact can carry, and against what the
 * OLD code still writes after it ran (the build runs beside the old code, and a rollback is code-only, so the old
 * writers (createSupplier (30, NULL), createCustomer 'days', the migration importer `?? 30`) must keep working).
 *
 * The harness has already applied 958 once. This test seeds the legacy shapes, runs the file's SQL again inside one
 * transaction (it is written to be re-run), asserts what each shape became, runs it a third time to prove the mapping
 * is idempotent, then ROLLS BACK: nothing it seeded, and nothing the re-run touched in other suites' rows, survives.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const MIGRATION = readFileSync(resolve(__dirname, '../../scripts/migrations/sql/958_payment_terms_model.sql'), 'utf8');

type Shape = [label: string, n: number | null, type: string | null, expectN: number | null, expectType: string | null];
const SHAPES: Shape[] = [
  ['30 days (the column default: never chosen)', 30, 'days', null, null],
  ['30 with no type (what old createSupplier wrote)', 30, null, null, null],
  ['45 days', 45, 'days', 45, 'invoice_days'],
  ['45 with no type', 45, null, 45, 'invoice_days'],
  ['0 days (Immediate)', 0, 'days', 0, 'invoice_days'],
  ['14 end_of_month', 14, 'end_of_month', 14, 'statement_days'],
  ['30 end_of_month (30, but a chosen type)', 30, 'end_of_month', 30, 'statement_days'],
  ['nothing', null, null, null, null],
  ['a type with no number', null, 'days', null, null],
  ['-1 days', -1, 'days', null, null],
  ['30 junk', 30, 'junk', null, null],
  ['1500 days (over the 999 the forms accept)', 1500, 'days', null, null],
  ['already new: 3 statement_months', 3, 'statement_months', 3, 'statement_months'],
  ['already new: 60 invoice_days', 60, 'invoice_days', 60, 'invoice_days'],
  ['already new: 30 invoice_days (chosen after 958, kept)', 30, 'invoice_days', 30, 'invoice_days'],
];

let company = '';
beforeAll(async () => {
  company = crypto.randomUUID();
  await pool.query('INSERT INTO companies(id, name) VALUES($1, $2)', [company, `958 ${company.slice(0, 8)}`]);
});
afterAll(async () => {
  await pool.query('DELETE FROM companies WHERE id = $1', [company]);
  await pool.end();
});

async function inTx<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    return await fn(db);
  } finally {
    await db.query('ROLLBACK');
    db.release();
  }
}

async function seed(db: PoolClient): Promise<Map<string, { table: 'suppliers' | 'customers'; id: string }>> {
  const ids = new Map<string, { table: 'suppliers' | 'customers'; id: string }>();
  for (const table of ['suppliers', 'customers'] as const) {
    for (const [label, n, type] of SHAPES) {
      const { rows } = await db.query(
        `INSERT INTO ${table}(company_id, name, payment_terms, payment_terms_type) VALUES($1, $2, $3, $4) RETURNING id`,
        [company, `${table}: ${label}`, n, type]);
      ids.set(`${table}: ${label}`, { table, id: rows[0].id as string });
    }
  }
  return ids;
}

async function stored(db: PoolClient, ids: Map<string, { table: 'suppliers' | 'customers'; id: string }>) {
  const out = new Map<string, [number | null, string | null]>();
  for (const [name, { table, id }] of ids) {
    const { rows } = await db.query(`SELECT payment_terms, payment_terms_type FROM ${table} WHERE id = $1`, [id]);
    out.set(name, [rows[0].payment_terms as number | null, rows[0].payment_terms_type as string | null]);
  }
  return out;
}

describe('migration 958 maps every legacy shape, and is safe to run again', () => {
  it('maps each shape on both tables, and a second and third run change nothing', async () => {
    await inTx(async (db) => {
      const ids = await seed(db);
      await db.query(MIGRATION);
      const first = await stored(db, ids);
      for (const table of ['suppliers', 'customers']) {
        for (const [label, , , expectN, expectType] of SHAPES) {
          expect(first.get(`${table}: ${label}`), `${table}: ${label}`).toEqual([expectN, expectType]);
        }
      }
      await db.query(MIGRATION);
      await db.query(MIGRATION);
      expect(await stored(db, ids)).toEqual(first);
    });
  });

  it('adds no column to companies (the company default is an accounting_settings row) and leaves a company\'s own default alone', async () => {
    const { rows: cols } = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'companies' AND column_name LIKE '%payment_terms%'");
    expect(cols).toEqual([]);
    await inTx(async (db) => {
      await db.query("INSERT INTO accounting_settings(company_id, key, value) VALUES($1, 'default_payment_terms', '{\"days\":2,\"type\":\"statement_months\"}')", [company]);
      await db.query(MIGRATION);
      const { rows } = await db.query("SELECT value FROM accounting_settings WHERE company_id = $1 AND key = 'default_payment_terms'", [company]);
      expect(rows[0].value).toBe('{"days":2,"type":"statement_months"}');
    });
  });
});

describe('after the expand step the OLD code\'s writes still succeed (it runs beside the new code, and after a code-only rollback)', () => {
  it('accepts (30, NULL), (30, days), a bare 30 on the column defaults, a customer\'s free-text type, and N over 999', async () => {
    await inTx(async (db) => {
      await db.query(MIGRATION);
      const writes: [string, unknown[]][] = [
        // old createSupplier: payment_terms ?? 30, no type column in its INSERT
        ['INSERT INTO suppliers(company_id, name, payment_terms) VALUES($1, $2, 30)', [company, 'old createSupplier']],
        ['INSERT INTO suppliers(company_id, name, payment_terms, payment_terms_type) VALUES($1, $2, 30, NULL)', [company, 'old (30, NULL)']],
        // old createCustomer: type defaulted to 'days'
        ["INSERT INTO customers(company_id, name, payment_terms, payment_terms_type) VALUES($1, $2, 30, 'days')", [company, 'old createCustomer']],
        ["INSERT INTO customers(company_id, name, payment_terms, payment_terms_type) VALUES($1, $2, 14, 'end_of_month')", [company, 'old EOM']],
        // old migrationContactService: `?? 30`, nothing else
        ['INSERT INTO customers(company_id, name, payment_terms) VALUES($1, $2, 30)', [company, 'old importer customer']],
        ['INSERT INTO customers(company_id, name) VALUES($1, $2)', [company, 'a row naming no terms at all']],
        // old MCP update_customer wrote any 30-character string as the type
        ["INSERT INTO customers(company_id, name, payment_terms, payment_terms_type) VALUES($1, $2, 7, 'weekly')", [company, 'old free-text type']],
        ['INSERT INTO suppliers(company_id, name, payment_terms) VALUES($1, $2, 1500)', [company, 'old 1500']],
      ];
      for (const [text, values] of writes) await expect(db.query(text, values), text).resolves.toBeDefined();
      await expect(db.query("UPDATE suppliers SET payment_terms = 45, payment_terms_type = 'days' WHERE company_id = $1 AND name = 'old createSupplier'", [company]))
        .resolves.toBeDefined();
    });
  });

  it('keeps the column defaults (30 and \'days\') and adds no CHECK on the contacts yet: that is PR 1b', async () => {
    const { rows: defaults } = await pool.query(
      `SELECT table_name, column_name, column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name IN ('suppliers', 'customers') AND column_name IN ('payment_terms', 'payment_terms_type')
       ORDER BY table_name, column_name`);
    expect(defaults.map((r) => `${r.table_name}.${r.column_name}`)).toEqual([
      'customers.payment_terms', 'customers.payment_terms_type', 'suppliers.payment_terms', 'suppliers.payment_terms_type']);
    for (const r of defaults) expect(String(r.column_default), `${r.table_name}.${r.column_name}`).not.toBe('null');
    expect(defaults.find((r) => r.table_name === 'suppliers' && r.column_name === 'payment_terms')!.column_default).toBe('30');
    const { rows: checks } = await pool.query(
      `SELECT conname FROM pg_constraint WHERE conrelid IN ('public.suppliers'::regclass, 'public.customers'::regclass)
         AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%payment_terms%'`);
    expect(checks).toEqual([]);
  });
});
