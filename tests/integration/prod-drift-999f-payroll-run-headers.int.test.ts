/**
 * Incident 19 Nov 2026 (migration 999f). Production's payroll_run_headers never got posted_journal_entry_id or
 * cancelled_by (both from 385_payroll_run_lifecycle.sql, applied to dev only), while the CI baseline (a dump of dev)
 * has them. So 999n applied on prod and its header freeze then failed every journal link on an approved run with
 * `record "new" has no field "posted_journal_entry_id"`, and 999w failed with 42703 on cancelled_by.
 *
 * This rebuilds prod's shape inside ONE transaction that is always rolled back: both columns dropped and 999w's
 * actor columns put back to uuid (prod has not run 999w). Then, in the order tonight's deploy runs them: 999n
 * applies; the approval's journal-link UPDATE fails with prod's exact error; 999w fails as at 01:32; 999f applies;
 * the same UPDATE succeeds and the freeze reads the new column; 999w, 999y and 1003 apply; the result has dev's shape.
 * The app-shaped writes run as migration_admin (not a superuser: 999n exempts one). Disposable fixture DB only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const sqlFile = (name: string) => readFileSync(`scripts/migrations/sql/${name}`, 'utf8');
const M999F = sqlFile('999f_payroll_run_headers_dev_only_columns.sql');
const M999N = sqlFile('999n_freeze_final_pay_runs_and_posted_journals.sql');
const M999W = sqlFile('999w_actor_ids_text.sql');
const LATER = ['999y_payroll_run_headers_drop_month_unique.sql', '1003_vat_returns_app_user_grant.sql'].map(sqlFile);

/** 999w's own list: every column it turns from uuid to TEXT. Prod still holds each as uuid. */
const ACTOR_COLUMNS: Array<[string, string]> = [
  ['payroll_run_headers', 'approved_by'], ['payroll_run_headers', 'created_by'], ['payroll_run_headers', 'prepared_by'],
  ['payroll_leave_requests', 'approved_by'], ['payroll_external_imports', 'created_by'],
  ['sars_efiling_events', 'created_by'], ['sars_submissions', 'submitted_by'], ['sars_source_codes', 'imported_by'],
  ['tax_directives', 'approved_by'], ['tax_directives', 'requested_by'], ['tax_directive_payments', 'created_by'],
  ['uif_declarations', 'submitted_by'], ['vat_returns', 'submitted_by'],
  ['vat_adjustments', 'approved_by'], ['vat_adjustments', 'created_by'],
];
const UUID_RE = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const PROD_ERROR = 'record "new" has no field "posted_journal_entry_id"';

const client = new Client({ connectionString: process.env.DATABASE_URL });
let run = '';
let journal = '';

/** One statement in its own savepoint: the error it raised, or null. The transaction survives either way. */
async function attempt(sql: string, params: unknown[] = []): Promise<{ message: string; code?: string } | null> {
  await client.query('SAVEPOINT attempt');
  try {
    await client.query(sql, params);
    await client.query('RELEASE SAVEPOINT attempt');
    return null;
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT attempt');
    const e = err as { message: string; code?: string };
    return { message: e.message, code: e.code };
  }
}
/** As migration_admin: not a superuser, so 999n's triggers judge it as they judge the app's pool on prod. */
async function asNonSuperuser(sql: string, params: unknown[] = []) {
  await client.query('SET ROLE migration_admin');
  try {
    expect((await client.query("SELECT current_setting('is_superuser') AS su")).rows[0].su).toBe('off');
    return await attempt(sql, params);
  } finally {
    await client.query('RESET ROLE');
  }
}
/** postPayrollRunJournal's link: onto the approved run, only while it has no journal. */
const linkJournal = () => asNonSuperuser(
  `UPDATE payroll_run_headers SET journal_entry_id = $2::uuid, updated_at = NOW()
    WHERE id = $1::uuid AND journal_entry_id IS NULL`, [run, journal]);
const columnsOf = async (table: string, cols: string[]) => Object.fromEntries((await client.query(
  `SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1 AND column_name = ANY($2::text[])`, [table, cols]))
  .rows.map((r: { column_name: string; data_type: string }) => [r.column_name, r.data_type]));

beforeAll(async () => {
  await client.connect();
  await client.query('BEGIN');
  // Production's shape, before tonight's deploy.
  await client.query('ALTER TABLE public.payroll_run_headers DROP COLUMN posted_journal_entry_id, DROP COLUMN cancelled_by');
  for (const [table, col] of ACTOR_COLUMNS) {
    // Only inside this rolled-back transaction: a value that is not a uuid (none on prod's uuid columns) maps to a fixed one.
    await client.query(`ALTER TABLE public.${table} ALTER COLUMN ${col} TYPE uuid USING (CASE WHEN ${col} IS NULL THEN NULL
      WHEN ${col} ~* '${UUID_RE}' THEN ${col}::uuid ELSE '00000000-0000-0000-0000-000000000000'::uuid END)`);
  }
  expect(await columnsOf('payroll_run_headers', ['posted_journal_entry_id', 'cancelled_by'])).toEqual({});

  const company = (await client.query("INSERT INTO companies (name) VALUES ('999f prod-drift Co') RETURNING id")).rows[0].id;
  journal = (await client.query(
    `INSERT INTO gl_journal_entries (company_id, entry_date, description, source, status, created_by)
     VALUES ($1, '2026-01-25', 'Payroll run 2026-01', 'auto_payroll', 'posted', gen_random_uuid()) RETURNING id`,
    [company])).rows[0].id;
  run = (await client.query(
    `INSERT INTO payroll_run_headers (company_id, period_month, period_year, status, run_date, total_gross, total_net, employee_count)
     VALUES ($1, 1, 2026, 'calculated', '2026-01-25', 1000, 800, 1) RETURNING id`, [company])).rows[0].id;
}, 120_000);

afterAll(async () => {
  await client.query('ROLLBACK').catch(() => undefined);
  await client.end();
});

describe('999f: production payroll_run_headers drift', () => {
  it('reproduces prod: 999n applies, then an approved run refuses its journal link with the prod error', async () => {
    expect(await attempt(M999N)).toBeNull();
    // approvePayrollRun's status write: OLD is not final yet, so the freeze returns before reading the missing column.
    expect(await asNonSuperuser(
      `UPDATE payroll_run_headers SET status = 'approved', approved_at = clock_timestamp(), updated_at = NOW()
        WHERE id = $1::uuid`, [run])).toBeNull();
    const err = await linkJournal();
    expect(err?.message).toBe(PROD_ERROR);
  });

  it('reproduces the 01:32 deploy failure: 999w on prod\'s shape stops on cancelled_by', async () => {
    const err = await attempt(M999W);
    expect(err?.code).toBe('42703');
    expect(err?.message).toBe('column "cancelled_by" does not exist');
  });

  it('999f adds both columns, and the same journal link then succeeds', async () => {
    expect(await attempt(M999F)).toBeNull();
    expect(await columnsOf('payroll_run_headers', ['posted_journal_entry_id', 'cancelled_by']))
      .toEqual({ posted_journal_entry_id: 'uuid', cancelled_by: 'text' });
    expect(await linkJournal()).toBeNull();
    const row = (await client.query('SELECT journal_entry_id, posted_journal_entry_id FROM payroll_run_headers WHERE id = $1', [run])).rows[0];
    expect(row).toEqual({ journal_entry_id: journal, posted_journal_entry_id: null });
  });

  it('the freeze now reads posted_journal_entry_id: moving it on the final run is refused', async () => {
    const err = await asNonSuperuser('UPDATE payroll_run_headers SET posted_journal_entry_id = $2::uuid WHERE id = $1::uuid', [run, journal]);
    expect(err?.message).toBe('payroll_run_headers: a final pay run\'s figures are frozen (reopen it first)');
  });

  it('999w, 999y and 1003 then apply, leaving dev\'s shape', async () => {
    expect(await attempt(M999W)).toBeNull();
    for (const sql of LATER) expect(await attempt(sql)).toBeNull();
    expect(await columnsOf('payroll_run_headers', ['posted_journal_entry_id', 'cancelled_by', 'approved_by', 'prepared_by']))
      .toEqual({ posted_journal_entry_id: 'uuid', cancelled_by: 'text', approved_by: 'text', prepared_by: 'text' });
    const fk = (await client.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'public.payroll_run_headers'::regclass AND conname = 'payroll_run_headers_posted_je_fkey'`)).rows;
    expect(fk).toEqual([{ def: 'FOREIGN KEY (posted_journal_entry_id) REFERENCES gl_journal_entries(id) ON DELETE SET NULL' }]);
    const idx = (await client.query(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_payroll_run_headers_posted_je'`)).rows;
    expect(idx).toEqual([{ indexdef: 'CREATE INDEX idx_payroll_run_headers_posted_je ON public.payroll_run_headers USING btree (posted_journal_entry_id) WHERE (posted_journal_entry_id IS NOT NULL)' }]);
  });

  it('999f is a no-op where the columns exist (dev, the CI fixture): a second run changes nothing', async () => {
    const before = (await client.query(
      `SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'public.payroll_run_headers'::regclass`)).rows[0].n;
    expect(await attempt(M999F)).toBeNull();
    expect(await columnsOf('payroll_run_headers', ['cancelled_by'])).toEqual({ cancelled_by: 'text' });
    expect((await client.query(
      `SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'public.payroll_run_headers'::regclass`)).rows[0].n).toBe(before);
  });
});
