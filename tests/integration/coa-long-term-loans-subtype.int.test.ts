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

const describeIfDb = isDisposableDb(process.env.DATABASE_URL) ? describe : describe.skip;
const MIGRATION = readFileSync(join(process.cwd(), 'scripts/migrations/sql/958_seeded_long_term_loans_subtype.sql'), 'utf8');
/** The backfill statement, exactly as the migration states it. */
const BACKFILL = MIGRATION.slice(MIGRATION.indexOf('UPDATE public.gl_accounts'), MIGRATION.lastIndexOf('-- 3.')).trim();

const NEW_CO = randomUUID();
const LEGACY = { seeded: randomUUID(), other: randomUUID(), userSet: randomUUID(), renamed: randomUUID(), code2211: randomUUID(), seededToo: randomUUID() };
const TEMPLATE_CO = Object.fromEntries(Object.keys(LEGACY).map((k) => [k, randomUUID()])) as Record<keyof typeof LEGACY, string>;
let pool: Pool;

async function legacyAccount(co: string, code: string, name: string, subtype: string | null): Promise<string> {
  const id = randomUUID();
  await pool.query(`INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance)
                    VALUES ($1,$2,$3,$4,'liability',$5,'credit')`, [id, co, code, name, subtype]);
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
    ids.code2211 = await legacyAccount(TEMPLATE_CO.code2211, '2211', 'Long-term Loans', null);
  }, 60_000);

  afterAll(async () => {
    if (!pool) return;
    try {
      for (const c of [NEW_CO, ...Object.values(TEMPLATE_CO)]) {
        await pool.query('DELETE FROM gl_accounts WHERE company_id = $1', [c]);
        await pool.query('DELETE FROM entity_changes WHERE company_id = $1', [c]).catch(() => undefined);
        await pool.query('DELETE FROM companies WHERE id = $1', [c]);
      }
    } finally { await pool.end(); }
  });

  it('a new company\'s seeded 2210 carries long_term_liability, and the rest of the chart is as it was', async () => {
    const rows = (await pool.query(`SELECT account_code, account_subtype FROM gl_accounts WHERE company_id = $1`, [NEW_CO])).rows as Array<{ account_code: string; account_subtype: string | null }>;
    const by = Object.fromEntries(rows.map((r) => [r.account_code, r.account_subtype]));
    expect(by['2210']).toBe('long_term_liability');
    expect(by['2215']).toBe('current_liability'); // the current portion of LT debt stays current
    expect(by['2130']).toBeNull();                // Accrued Expenses: untouched
    expect(by['2110']).toBe('payable');
    expect(by['4410']).toBe('disposal_profit_loss');
    expect(rows.length).toBeGreaterThan(30);
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
  });

  it('a second run changes nothing', async () => {
    expect((await pool.query(BACKFILL)).rowCount).toBe(0);
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
