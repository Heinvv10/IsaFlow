// Migration 958: the seeded "Long-term Loans" (2210) carries the long_term_liability subtype.
// With no subtype a loan was a CURRENT liability on the balance sheet and OPERATING on both cash flow statements.
// Checks, against the schema the integration harness builds (the migration applied as the non-superuser deploy role):
// the seeder gives new companies the subtype and changes nothing else; the backfill UPDATE (read from the migration file
// and run here) touches exactly the NULL-subtype exact-name 2210 liability rows and nothing a user set; a second run is a
// no-op; the entity-change audit sees the change; the definer registry row matches the redefined seeder.
// Seeds its own companies: disposable database only.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertDisposableDb, isDisposableDb } from '../helpers/assertDisposableDb';
import { getIndirectCashFlow } from '@/modules/accounting/services/reports/cashFlowIndirectService';

const describeIfDb = isDisposableDb(process.env.DATABASE_URL) ? describe : describe.skip;
const MIGRATION = readFileSync(join(process.cwd(), 'scripts/migrations/sql/958_seeded_long_term_loans_subtype.sql'), 'utf8');
/** The backfill statement, exactly as the migration states it. */
const BACKFILL_AND_GUARD = MIGRATION.slice(MIGRATION.indexOf('UPDATE public.gl_accounts'), MIGRATION.lastIndexOf('-- 3.')).trim();
const BACKFILL = BACKFILL_AND_GUARD.slice(0, BACKFILL_AND_GUARD.indexOf('-- 2b.')).trim();

const NEW_CO = randomUUID();
const LEGACY = { notLiability: randomUUID(), seeded: randomUUID(), other: randomUUID(), userSet: randomUUID(), renamed: randomUUID(), code2211: randomUUID(), seededToo: randomUUID() };
const TEMPLATE_CO = Object.fromEntries(Object.keys(LEGACY).map((k) => [k, randomUUID()])) as Record<keyof typeof LEGACY, string>;
let pool: Pool;

/** The chart 701's seeder created: its body, loaded under another name so both seeders can run in one database. */
async function previousChartWithout2210() {
  const sql701 = readFileSync(join(process.cwd(), 'scripts/migrations/sql/701_vat_input_late_claim_account.sql'), 'utf8');
  const start = sql701.indexOf('CREATE OR REPLACE FUNCTION public.seed_company_chart_of_accounts');
  const end = sql701.indexOf('$$;', start) + 3;
  const fn = sql701.slice(start, end).replace('public.seed_company_chart_of_accounts', 'pg_temp.seed_chart_701');
  const co = randomUUID();
  const client = await pool.connect();
  try {
    await client.query(`INSERT INTO companies (id, name, is_active) VALUES ($1, '958 prev', true)`, [co]);
    await client.query(fn);
    await client.query('SELECT pg_temp.seed_chart_701($1)', [co]);
    const rows = (await client.query(
      `SELECT account_code, account_name, account_type, account_subtype, normal_balance, level, is_system_account FROM gl_accounts WHERE company_id = $1 AND account_code <> '2210' ORDER BY account_code`, [co])).rows;
    await client.query('DELETE FROM gl_accounts WHERE company_id = $1', [co]);
    await client.query('DELETE FROM companies WHERE id = $1', [co]);
    return rows;
  } finally {
    await client.query('DROP FUNCTION IF EXISTS pg_temp.seed_chart_701(uuid)'); // a pooled session must not keep an unreviewed definer
    client.release();
  }
}

async function legacyAccount(co: string, code: string, name: string, subtype: string | null, type = 'liability'): Promise<string> {
  const id = randomUUID();
  await pool.query(`INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance)
                    VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, co, code, name, type, subtype, type === 'liability' ? 'credit' : 'debit']);
  return id;
}
const subtypeOf = async (id: string) => (await pool.query('SELECT account_subtype FROM gl_accounts WHERE id = $1', [id])).rows[0].account_subtype as string | null;

describeIfDb('migration 958: seeded Long-term Loans subtype', () => {
  const ids: Record<string, string> = {};
  beforeAll(async () => {
    assertDisposableDb('This test inserts and deletes companies and accounts.');
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    for (const c of [NEW_CO, ...Object.values(TEMPLATE_CO)]) await pool.query(`INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true)`, [c, `958 ${c.slice(0, 6)}`]);
    await pool.query('SELECT public.seed_company_chart_of_accounts($1)', [NEW_CO]);
    ids.seeded = await legacyAccount(TEMPLATE_CO.seeded, '2210', 'Long-term Loans', null);
    ids.seededToo = await legacyAccount(TEMPLATE_CO.seededToo, '2210', 'Long-term Loans', null);
    ids.other = await legacyAccount(TEMPLATE_CO.other, '2210', 'Long-term Loans', 'other');
    ids.userSet = await legacyAccount(TEMPLATE_CO.userSet, '2210', 'Long-term Loans', 'current_liability');
    ids.renamed = await legacyAccount(TEMPLATE_CO.renamed, '2210', 'Bank loans', null);
    ids.notLiability = await legacyAccount(TEMPLATE_CO.notLiability, '2210', 'Long-term Loans', null, 'asset'); // a 2210 of another type
    ids.code2211 = await legacyAccount(TEMPLATE_CO.code2211, '2211', 'Long-term Loans', null);
  }, 60_000);

  afterAll(async () => {
    if (!pool) return;
    try {
      for (const c of [NEW_CO, ...Object.values(TEMPLATE_CO)]) {
        await pool.query('DELETE FROM gl_accounts WHERE company_id = $1', [c]);
        await pool.query('DELETE FROM companies WHERE id = $1', [c]);
      }
    } finally { await pool.end(); }
  });

  it('a new company\'s seeded 2210 carries long_term_liability, and the rest of the chart is exactly what it was', async () => {
    const chart = async (co: string) => (await pool.query(
      `SELECT account_code, account_name, account_type, account_subtype, normal_balance, level, is_system_account FROM gl_accounts WHERE company_id = $1 ORDER BY account_code`, [co])).rows;
    const rows = await chart(NEW_CO);
    const without2210 = rows.filter((r) => r.account_code !== '2210');
    expect(rows.find((r) => r.account_code === '2210')).toMatchObject({ account_type: 'liability', account_subtype: 'long_term_liability' });
    // The chart as 701 seeded it, from a company seeded by the PREVIOUS definition of the seeder (701's body, re-created here
    // as a function of its own, so the comparison is every code, type and subtype, not a few spot codes).
    expect(without2210).toEqual(await previousChartWithout2210());
    expect(rows.length).toBeGreaterThan(30);
  });

  it('a loan drawn on the SEEDED 2210 is Financing on the cash flow, not Operating (the review\'s B1)', async () => {
    const acct = async (code: string) => (await pool.query('SELECT id FROM gl_accounts WHERE company_id = $1 AND account_code = $2', [NEW_CO, code])).rows[0].id as string;
    const bank = randomUUID();
    await pool.query(`INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance) VALUES ($1,$2,'1990','958 bank','asset','bank','debit')`, [bank, NEW_CO]);
    try {
      const e = await pool.query(`INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, status, created_by) VALUES ($1,'958-LOAN','2026-11-10','loan','draft',$1) RETURNING id`, [NEW_CO]);
      await pool.query(`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit) VALUES ($1,$2,$3,50000,0),($1,$2,$4,0,50000)`, [NEW_CO, e.rows[0].id, bank, await acct('2210')]);
      await pool.query(`UPDATE gl_journal_entries SET status='posted' WHERE id = $1`, [e.rows[0].id]);
      const cf = await getIndirectCashFlow(NEW_CO, '2026-11-01', '2026-11-30');
      const total = (name: string) => cf.sections.find((x) => x.section.startsWith(name))!.total;
      expect({ operating: total('Operating'), financing: total('Financing') }).toEqual({ operating: 0, financing: 50000 });
    } finally {
      await pool.query('DELETE FROM gl_journal_lines WHERE company_id = $1', [NEW_CO]);
      await pool.query('DELETE FROM gl_journal_entries WHERE company_id = $1', [NEW_CO]);
    }
  });

  it('the backfill changes exactly the NULL-subtype, exact-name 2210 liability rows', async () => {
    expect(BACKFILL).toMatch(/^UPDATE public\.gl_accounts[\s\S]*account_subtype IS NULL;$/);
    const changed = (await pool.query(BACKFILL)).rowCount;
    expect(changed).toBeGreaterThanOrEqual(2); // the two legacy fixtures (a dev DB may hold more of them)
    expect(await subtypeOf(ids.seeded!)).toBe('long_term_liability');
    expect(await subtypeOf(ids.seededToo!)).toBe('long_term_liability');
    expect(await subtypeOf(ids.other!)).toBe('other');                    // one carrying `other` is not touched
    expect(await subtypeOf(ids.userSet!)).toBe('current_liability');      // a user-set subtype is never touched
    expect(await subtypeOf(ids.renamed!)).toBeNull();                      // another name
    expect(await subtypeOf(ids.code2211!)).toBeNull();                     // another code
    expect(await subtypeOf(ids.notLiability!)).toBeNull();                 // not a liability
  });

  it('a second run changes nothing', async () => {
    expect((await pool.query(BACKFILL)).rowCount).toBe(0);
  });

  it('as a role the row-level-security policies filter, the migration RAISES instead of updating nothing', async () => {
    const role = `m958_probe_${randomUUID().slice(0, 8)}`;
    const client = await pool.connect();
    let inTx = false;
    try {
      await client.query(`CREATE ROLE ${role} NOLOGIN NOBYPASSRLS`);
      await client.query(`GRANT SELECT, UPDATE ON public.gl_accounts TO ${role}`);
      await client.query('GRANT USAGE ON SCHEMA public TO ' + role);
      await client.query('BEGIN');
      inTx = true;
      await client.query(`SET LOCAL ROLE ${role}`);
      // No tenant claims: the policies show this role nothing, so the backfill alone reports "UPDATE 0" without error.
      expect((await client.query(BACKFILL)).rowCount).toBe(0);
      await expect(client.query(BACKFILL_AND_GUARD)).rejects.toThrow(/958: row level security applies to .* silently change nothing/);
    } finally {
      if (inTx) await client.query('ROLLBACK');
      await client.query(`REVOKE ALL ON public.gl_accounts FROM ${role}`);
      await client.query(`REVOKE USAGE ON SCHEMA public FROM ${role}`);
      await client.query(`DROP ROLE ${role}`);
      client.release();
    }
  });

  it('as the owner role the guard passes once nothing is left, and raises if the UPDATE left a row unset', async () => {
    await pool.query(BACKFILL);
    await pool.query(BACKFILL_AND_GUARD); // nothing of the kind left: no raise
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // A trigger that undoes the UPDATE stands in for whatever could leave a row unset behind the migration's back.
      await client.query(`CREATE FUNCTION pg_temp.undo_958() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.account_subtype := NULL; RETURN NEW; END $$`);
      await client.query('CREATE TRIGGER zz_undo_958 BEFORE UPDATE ON public.gl_accounts FOR EACH ROW EXECUTE FUNCTION pg_temp.undo_958()');
      const co = randomUUID();
      await client.query(`INSERT INTO companies (id, name, is_active) VALUES ($1, '958 guard', true)`, [co]);
      await client.query(`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance) VALUES ($1,'2210','Long-term Loans','liability','credit')`, [co]);
      await expect(client.query(BACKFILL_AND_GUARD)).rejects.toThrow(/958: 1 seeded Long-term Loans account\(s\) still have no subtype/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('the change is in the entity-change audit', async () => {
    const rows = (await pool.query(`SELECT changed, after FROM entity_changes WHERE company_id = $1 AND entity_type = 'gl_account' AND op = 'update'`, [TEMPLATE_CO.seeded])).rows as Array<{ changed: string[] }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.changed).toContain('account_subtype');
  });

  it('the definer registry matches the redefined seeder, and no definer is unreviewed', async () => {
    const row = (await pool.query(`SELECT r.body_md5 = public.app_definer_hash('public.seed_company_chart_of_accounts(uuid)'::regprocedure) AS ok
                                    FROM public.app_definer_reviews r WHERE r.signature = 'seed_company_chart_of_accounts(uuid)'`)).rows[0];
    expect(row?.ok).toBe(true);
    const violations = (await pool.query('SELECT * FROM public.app_pool_reach_violations()')).rows;
    expect(violations).toEqual([]);
  });

  it('the seeder is callable by the migration role only (grants as 701 left them)', async () => {
    const g = (await pool.query(`SELECT has_function_privilege('app_user', 'public.seed_company_chart_of_accounts(uuid)', 'EXECUTE') AS app_user,
                                        has_function_privilege('migration_admin', 'public.seed_company_chart_of_accounts(uuid)', 'EXECUTE') AS migration_admin`)).rows[0];
    expect(g).toEqual({ app_user: false, migration_admin: true });
  });
});
