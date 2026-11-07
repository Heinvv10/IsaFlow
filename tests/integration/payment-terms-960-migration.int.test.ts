/**
 * Migration 960 (payment terms, the EXPAND half) changes NO contact row: it only drops the column defaults. The build that
 * ships it runs beside the OLD code (and a rollback is code-only), and master's ar/paymentTerms.dueDateFromTerms gives a
 * date only for `days` and `end_of_month`: rewriting (30, 'days') to NULL / NULL, or 'days' to 'invoice_days', would leave
 * the old code dating nearly every new customer invoice with no due date. The data mapping is PR 1b's (plan doc).
 *
 * The harness has already applied 960 once. This test seeds every legacy shape, runs the file's SQL again inside one
 * transaction, asserts no row changed and that the OLD code's date for each is the same as before, runs it twice more, then
 * ROLLS BACK: nothing it seeded survives. Also: the old code's writes still succeed after it, the defaults are gone, and a
 * contact UPDATE (as PR 1b's will be) is recorded in entity_changes with the terms before and after.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { addDaysISO, localDateFromISO, monthEndISO } from '../../src/lib/dateUtils';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const MIGRATION = readFileSync(resolve(__dirname, '../../scripts/migrations/sql/960_payment_terms_model.sql'), 'utf8');

/** Master's ar/paymentTerms.dueDateFromTerms, verbatim: what the OLD code (the live colour, a rolled-back build) makes of a stored row. */
function oldDueDate(invoiceDateIso: string, days: number | null, type: string | null): string | null {
  const invoiceDate = localDateFromISO(invoiceDateIso);
  if (invoiceDate === null || days === null || !Number.isInteger(days) || days < 0) return null;
  if (type === 'days') return addDaysISO(invoiceDateIso, days);
  if (type === 'end_of_month') return addDaysISO(monthEndISO(invoiceDate), days);
  return null;
}

type Shape = [label: string, n: number | null, type: string | null, oldDate: string | null];
/** Every legacy shape a contact can carry, and the due date the old code gives it for an invoice dated 2026-10-15. */
const SHAPES: Shape[] = [
  ['30 days (the old column default)', 30, 'days', '2026-11-14'],
  ['30 with no type (what old createSupplier wrote)', 30, null, null],
  ['45 days', 45, 'days', '2026-11-29'],
  ['0 days (Immediate)', 0, 'days', '2026-10-15'],
  ['14 end_of_month', 14, 'end_of_month', '2026-11-14'],
  ['nothing', null, null, null],
  ['-1 days', -1, 'days', null],
  ['30 junk', 30, 'junk', null],
  ['1500 days (over the 999 the forms accept)', 1500, 'days', '2030-11-23'],
  ['already new: 3 statement_months', 3, 'statement_months', null],
  ['already new: 60 invoice_days', 60, 'invoice_days', null],
];

let company = '';
beforeAll(async () => {
  company = crypto.randomUUID();
  await pool.query('INSERT INTO companies(id, name) VALUES($1, $2)', [company, `960 ${company.slice(0, 8)}`]);
});
afterAll(async () => {
  await pool.query('DELETE FROM companies WHERE id = $1', [company]);
  await pool.end();
});

async function inTx<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    // 963 (PR 1b) later added the shape CHECKs these legacy shapes violate; 960 is tested as it stood, so they are
    // dropped inside this rolled-back transaction (963's own suite pins the tightened state).
    await db.query('ALTER TABLE suppliers DROP CONSTRAINT IF EXISTS suppliers_payment_terms_shape');
    await db.query('ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_payment_terms_shape');
    return await fn(db);
  } finally {
    await db.query('ROLLBACK');
    db.release();
  }
}

type Ids = Map<string, { table: 'suppliers' | 'customers'; id: string }>;
async function seed(db: PoolClient): Promise<Ids> {
  const ids: Ids = new Map();
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

async function stored(db: PoolClient, ids: Ids) {
  const out = new Map<string, [number | null, string | null]>();
  for (const [name, { table, id }] of ids) {
    const { rows } = await db.query(`SELECT payment_terms, payment_terms_type FROM ${table} WHERE id = $1`, [id]);
    out.set(name, [rows[0].payment_terms as number | null, rows[0].payment_terms_type as string | null]);
  }
  return out;
}

describe('migration 960 leaves every contact row exactly as it was, and is safe to run again', () => {
  it('changes no row of either table, and the old code still dates each legacy shape as before', async () => {
    await inTx(async (db) => {
      const ids = await seed(db);
      const before = await stored(db, ids);
      await db.query(MIGRATION);
      const after = await stored(db, ids);
      expect(after).toEqual(before);
      for (const table of ['suppliers', 'customers']) {
        for (const [label, n, type, oldDate] of SHAPES) {
          const row = after.get(`${table}: ${label}`)!;
          expect(row, `${table}: ${label}`).toEqual([n, type]);
          expect(oldDueDate('2026-10-15', row[0], row[1]), `${table}: ${label} (old code)`).toBe(oldDate);
        }
      }
      await db.query(MIGRATION);
      await db.query(MIGRATION);
      expect(await stored(db, ids)).toEqual(before);
    });
  });

  it('the old code still dates a (30, \'days\') customer: 960 did not rewrite it to NULL / NULL', async () => {
    await inTx(async (db) => {
      const { rows } = await db.query("INSERT INTO customers(company_id, name, payment_terms, payment_terms_type) VALUES($1, 'Legacy', 30, 'days') RETURNING id", [company]);
      await db.query(MIGRATION);
      const { rows: after } = await db.query('SELECT payment_terms, payment_terms_type FROM customers WHERE id = $1', [rows[0].id]);
      expect(oldDueDate('2026-10-15', after[0].payment_terms, after[0].payment_terms_type)).toBe('2026-11-14');
    });
  });

  it('a contact UPDATE of the terms (what PR 1b will do) is recorded in entity_changes: before and after, both columns', async () => {
    await inTx(async (db) => {
      const ids = await seed(db);
      for (const table of ['suppliers', 'customers'] as const) {
        const { id } = ids.get(`${table}: 30 days (the old column default)`)!;
        await db.query(`UPDATE ${table} SET payment_terms = NULL, payment_terms_type = NULL WHERE id = $1`, [id]);
        const { rows } = await db.query(
          "SELECT op, changed, before, after FROM entity_changes WHERE entity_id = $1 AND op = 'update'", [id]);
        expect(rows, table).toHaveLength(1);
        expect(rows[0].changed, table).toEqual(['payment_terms', 'payment_terms_type']);
        expect(rows[0].before).toMatchObject({ payment_terms: 30, payment_terms_type: 'days' });
        expect(rows[0].after).toMatchObject({ payment_terms: null, payment_terms_type: null });
      }
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
  it('accepts (30, NULL), (30, days), a bare 30, a customer\'s free-text type, and N over 999', async () => {
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
        ['INSERT INTO customers(company_id, name) VALUES($1, $2)', [company, 'a row naming no terms at all']], // stores NULL / NULL now
        // old MCP update_customer wrote any 30-character string as the type
        ["INSERT INTO customers(company_id, name, payment_terms, payment_terms_type) VALUES($1, $2, 7, 'weekly')", [company, 'old free-text type']],
        ['INSERT INTO suppliers(company_id, name, payment_terms) VALUES($1, $2, 1500)', [company, 'old 1500']],
      ];
      for (const [text, values] of writes) await expect(db.query(text, values), text).resolves.toBeDefined();
      await expect(db.query("UPDATE suppliers SET payment_terms = 45, payment_terms_type = 'days' WHERE company_id = $1 AND name = 'old createSupplier'", [company]))
        .resolves.toBeDefined();
    });
  });

  it('drops the column defaults (a bare insert is not set); the only terms CHECKs are 963\'s (PR 1b), 960 adds none', async () => {
    const { rows: defaults } = await pool.query(
      `SELECT table_name, column_name, column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name IN ('suppliers', 'customers') AND column_name IN ('payment_terms', 'payment_terms_type')
       ORDER BY table_name, column_name`);
    expect(defaults.map((r) => `${r.table_name}.${r.column_name}`)).toEqual([
      'customers.payment_terms', 'customers.payment_terms_type', 'suppliers.payment_terms', 'suppliers.payment_terms_type']);
    for (const r of defaults) expect(r.column_default, `${r.table_name}.${r.column_name}`).toBeNull();
    const { rows: checks } = await pool.query(
      `SELECT conname FROM pg_constraint WHERE conrelid IN ('public.suppliers'::regclass, 'public.customers'::regclass)
         AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%payment_terms%'`);
    expect(checks.map((r) => r.conname).sort()).toEqual(['customers_payment_terms_shape', 'suppliers_payment_terms_shape']);
    expect(MIGRATION).not.toMatch(/ADD\s+CONSTRAINT/i);
  });
});
