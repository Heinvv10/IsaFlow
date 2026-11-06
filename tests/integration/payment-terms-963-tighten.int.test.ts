/**
 * Migration 963 (payment terms, the TIGHTEN half, PR 1b) against every legacy shape a contact can carry. The harness has
 * applied 963 already, so each case runs in ONE transaction that drops the two shape CHECKs, seeds the legacy shapes,
 * runs the file's SQL again, asserts, runs it a third time (idempotent), and ROLLS BACK: nothing it seeded, and nothing
 * the re-run touched in other suites' rows, survives.
 *   - stamped defaults (30, 'days' / NULL) become not set where the company default is still 30 days from invoice, and
 *     an explicit 30 days from invoice where the company changed its default (Hein, 2026-11-07);
 *   - every other legacy shape maps to the new names; bad values become not set;
 *   - each change is recorded in the entity history (the only copy of the old values);
 *   - the CHECK refuses every pair the forms would refuse.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const MIGRATION = readFileSync(resolve(__dirname, '../../scripts/migrations/sql/963_payment_terms_tighten.sql'), 'utf8');
const DEFAULT_30 = '{"days":30,"type":"invoice_days"}';

type Shape = [label: string, n: number | null, type: string | null, expectN: number | null, expectType: string | null];
const SHAPES: Shape[] = [
  ['30 days (the column default: never chosen)', 30, 'days', null, null],
  ['30 with no type (what old createSupplier wrote)', 30, null, null, null],
  ['45 days', 45, 'days', 45, 'invoice_days'],
  ['45 with no type', 45, null, 45, 'invoice_days'],
  // An empty type is read as no type (readTerms): it dated as invoice days, so it must keep doing so (blind review M1).
  ['45 with an empty type', 45, '', 45, 'invoice_days'],
  ['30 with an empty type (read as the stamped default)', 30, '', null, null],
  ['0 days (Immediate)', 0, 'days', 0, 'invoice_days'],
  ['14 end_of_month', 14, 'end_of_month', 14, 'statement_days'],
  ['30 end_of_month (30, but a chosen type)', 30, 'end_of_month', 30, 'statement_days'],
  ['nothing', null, null, null, null],
  ['a type with no number', null, 'days', null, null],
  ['-1 days', -1, 'days', null, null],
  ['30 junk', 30, 'junk', null, null],
  ['1500 days (over the 999 the forms accept)', 1500, 'days', null, null],
  ['already new: 3 statement_months', 3, 'statement_months', 3, 'statement_months'],
  ['already new: 30 invoice_days (chosen after 960, kept)', 30, 'invoice_days', 30, 'invoice_days'],
];
/** Where the company changed its default, a stamped 30 becomes an explicit 30 days from invoice; the rest as above. */
const CHANGED: Record<string, [number | null, string | null]> = {
  '30 days (the column default: never chosen)': [30, 'invoice_days'],
  '30 with no type (what old createSupplier wrote)': [30, 'invoice_days'],
  '30 with an empty type (read as the stamped default)': [30, 'invoice_days'],
};

const companies: string[] = [];
beforeAll(async () => {
  for (let i = 0; i < 3; i++) {
    const id = crypto.randomUUID();
    await pool.query('INSERT INTO companies(id, name) VALUES($1, $2)', [id, `963 ${id.slice(0, 8)}`]);
    companies.push(id);
  }
});
afterAll(async () => {
  await pool.query('DELETE FROM companies WHERE id = ANY($1)', [companies]);
  await pool.end();
});

async function inTx<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('ALTER TABLE suppliers DROP CONSTRAINT suppliers_payment_terms_shape');
    await db.query('ALTER TABLE customers DROP CONSTRAINT customers_payment_terms_shape');
    return await fn(db);
  } finally {
    await db.query('ROLLBACK');
    db.release();
  }
}

async function seed(db: PoolClient, company: string) {
  const out = new Map<string, { table: 'suppliers' | 'customers'; id: string }[]>();
  for (const [label, n, type] of SHAPES) {
    for (const table of ['suppliers', 'customers'] as const) {
      const { rows } = await db.query(`INSERT INTO ${table}(company_id, name, payment_terms, payment_terms_type) VALUES($1,$2,$3,$4) RETURNING id`,
        [company, `963 ${label}`, n, type]);
      out.set(label, [...(out.get(label) ?? []), { table, id: rows[0].id as string }]);
    }
  }
  return out;
}
const termsOf = async (db: PoolClient, table: string, id: string) =>
  (await db.query(`SELECT payment_terms AS n, payment_terms_type AS t FROM ${table} WHERE id = $1`, [id])).rows[0] as { n: number | null; t: string | null };

describe('migration 963', () => {
  it.each([
    ['no default set', null],
    ['the default the app writes for 30 days from invoice', DEFAULT_30],
    ['a changed default (2 months after statement)', '{"days":2,"type":"statement_months"}'],
    ['an unreadable default', 'not json'],
  ])('maps every legacy shape (%s), idempotently', async (_why, setting) => {
    await inTx(async (db) => {
      const c = companies[0]!;
      if (setting !== null) await db.query("INSERT INTO accounting_settings(company_id, key, value) VALUES($1, 'default_payment_terms', $2)", [c, setting]);
      const ids = await seed(db, c);
      const changed = setting !== null && setting !== DEFAULT_30;
      for (let run = 0; run < 2; run++) {
        await db.query(MIGRATION);
        for (const [label, , , n, t] of SHAPES) {
          const [en, et] = changed && CHANGED[label] ? CHANGED[label]! : [n, t];
          for (const { table, id } of ids.get(label)!) expect(await termsOf(db, table, id), `${label} ${table} run ${run}`).toEqual({ n: en, t: et });
        }
      }
    });
  });

  it('judges each contact by its OWN company\'s default', async () => {
    await inTx(async (db) => {
      const [kept, changed] = [companies[1]!, companies[2]!];
      await db.query("INSERT INTO accounting_settings(company_id, key, value) VALUES($1, 'default_payment_terms', '{\"days\":60,\"type\":\"invoice_days\"}')", [changed]);
      const a = (await db.query("INSERT INTO suppliers(company_id, name, payment_terms, payment_terms_type) VALUES($1,'K',30,'days') RETURNING id", [kept])).rows[0].id;
      const b = (await db.query("INSERT INTO suppliers(company_id, name, payment_terms, payment_terms_type) VALUES($1,'C',30,'days') RETURNING id", [changed])).rows[0].id;
      await db.query(MIGRATION);
      expect(await termsOf(db, 'suppliers', a)).toEqual({ n: null, t: null });
      expect(await termsOf(db, 'suppliers', b)).toEqual({ n: 30, t: 'invoice_days' });
    });
  });

  it('records every change in the entity history (the undo record), and nothing for an unchanged row', async () => {
    await inTx(async (db) => {
      const c = companies[0]!;
      const stamped = (await db.query("INSERT INTO customers(company_id, name, payment_terms, payment_terms_type) VALUES($1,'S',30,'days') RETURNING id", [c])).rows[0].id;
      const fresh = (await db.query("INSERT INTO customers(company_id, name, payment_terms, payment_terms_type) VALUES($1,'F',3,'statement_months') RETURNING id", [c])).rows[0].id;
      await db.query(MIGRATION);
      const h = (await db.query("SELECT channel, before, after FROM entity_changes WHERE entity_id = $1 AND op = 'update'", [stamped])).rows;
      expect(h).toHaveLength(1);
      expect(h[0]).toMatchObject({ channel: 'system', before: { payment_terms: 30, payment_terms_type: 'days' }, after: { payment_terms: null, payment_terms_type: null } });
      expect((await db.query("SELECT 1 FROM entity_changes WHERE entity_id = $1 AND op = 'update'", [fresh])).rows).toHaveLength(0);
    });
  });

  it.each([
    [30, 'days'], [30, null], [null, 'invoice_days'], [-1, 'invoice_days'], [1000, 'invoice_days'], [30, 'end_of_month'], [5, 'junk'],
  ])('the CHECK refuses (%s, %s) on both tables', async (n, t) => {
    for (const table of ['suppliers', 'customers']) {
      await expect(pool.query(`INSERT INTO ${table}(company_id, name, payment_terms, payment_terms_type) VALUES($1,'X',$2,$3)`, [companies[0], n, t]))
        .rejects.toThrow(/payment_terms_shape/);
    }
  });

  it.each([[null, null], [0, 'invoice_days'], [999, 'statement_days'], [3, 'statement_months']])('the CHECK accepts (%s, %s)', async (n, t) => {
    const { rows } = await pool.query("INSERT INTO suppliers(company_id, name, payment_terms, payment_terms_type) VALUES($1,'OK',$2,$3) RETURNING id", [companies[0], n, t]);
    await pool.query('DELETE FROM suppliers WHERE id = $1', [rows[0].id]);
  });
});
