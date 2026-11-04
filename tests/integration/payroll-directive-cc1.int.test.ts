/**
 * Follow-up A of PR #1065: a SARS directive paid outside payroll
 * (applyTaxDirective) tags its labour like a pay run — the employee's
 * allocations split it, the cost-centre mapping picks each account, a taggable
 * centre is the line's CC1, an untaggable one posts untagged with the
 * `labour_cost_centre_untagged` advisory (never blocks). Its reversal mirrors
 * every CC1. And the lock order: the centres are held BEFORE the directive row,
 * as approval takes them (payrollCostCentreTags).
 *
 * Real routes (withAuth, app_user, RLS) on the disposable fixture.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import jeAction from '../../pages/api/accounting/journal-entries-action';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { applyStandalone, approvedDirective, cleanSeveranceFixtures, seedRetrenchedEmployee, type SeveranceFixture } from './p3-severance.helpers';
import type { Route } from './w3-01-payroll.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
let f: SeveranceFixture;
let acct5210 = '';
const cc = { a: crypto.randomUUID(), b: crypto.randomUUID(), old: crypto.randomUUID() };

type Line = [string, string | null, number, number];
const journalLines = async (journalId: string): Promise<Line[]> => (await pool.query(
  `SELECT a.account_code, l.cc1_id::text AS cc1, round(l.debit * 100)::int AS d, round(l.credit * 100)::int AS c
     FROM gl_journal_lines l JOIN gl_accounts a ON a.id = l.gl_account_id
    WHERE l.journal_entry_id = $1 ORDER BY a.account_code, l.cc1_id NULLS LAST`, [journalId])).rows.map((r) => [r.account_code, r.cc1, r.d, r.c]);

beforeAll(async () => {
  f = await seedRetrenchedEmployee(pool, '2026-08-31', 'cc1 directive');
  acct5210 = (await pool.query(
    `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level)
     VALUES ($1,'5210','Site labour','expense','debit',1) RETURNING id`, [f.company])).rows[0]!.id;
  for (const [id, code, active] of [[cc.a, 'DIR-A', true], [cc.b, 'DIR-B', true], [cc.old, 'DIR-OLD', false]] as const) {
    await pool.query("INSERT INTO cost_centres (id, company_id, code, name, cc_type, is_active) VALUES ($1,$2,$3,$3,'cc1',$4)", [id, f.company, code, active]);
  }
  // A and OLD map to 5210; B is unmapped (5200, keeps its CC1); OLD is inactive (5210, untagged).
  for (const id of [cc.a, cc.old]) {
    await pool.query('INSERT INTO cost_centre_gl_mappings (company_id, cost_centre_id, expense_account_id) VALUES ($1,$2,$3)', [f.company, id, acct5210]);
  }
  for (const [id, pct] of [[cc.a, 50], [cc.b, 30], [cc.old, 20]] as const) {
    await pool.query('INSERT INTO payroll_employee_cost_allocations (company_id, employee_id, cost_centre_id, percentage) VALUES ($1,$2,$3,$4)',
      [f.company, f.employee, id, pct]);
  }
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM payroll_employee_cost_allocations WHERE company_id = $1', [f.company]);
    await pool.query('DELETE FROM cost_centre_gl_mappings WHERE company_id = $1', [f.company]);
    await pool.query('UPDATE gl_journal_entries SET reversal_of_id = NULL WHERE company_id = $1', [f.company]);
    await pool.query('DELETE FROM tax_directive_payments WHERE company_id = $1', [f.company]);
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id = $1', [f.company]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id = $1', [f.company]);
    await cleanSeveranceFixtures(pool, [f]);
  } finally { await pool.end(); }
});

describe('a SARS directive paid outside payroll tags its labour with the employee\'s CC1', () => {
  it('splits by allocation, maps the account, tags taggable centres, names the rest — and its reversal mirrors it', async () => {
    const directive = await approvedDirective(f, 10000, 0.18, '2026-08-31', '1111111111');
    const paid = await applyStandalone(f, directive);
    expect(paid.statusCode).toBe(200);
    const journal = String(paid.body.data!.journalEntryId);
    expect(await journalLines(journal)).toEqual([
      ['1110', null, 0, 820000], ['2140', null, 0, 180000],
      ['5200', cc.b, 300000, 0], ['5210', cc.a, 500000, 0], ['5210', null, 200000, 0],
    ]);
    const advisory = (paid.body.data!.advisories as Array<{ code: string; detail: string }>).find((a) => a.code === 'labour_cost_centre_untagged');
    expect(advisory?.detail).toContain('DIR-OLD (inactive)');

    expect((await f.call(jeAction as Route, 'POST', '/api/accounting/journal-entries-action', undefined, { body: { id: journal, action: 'reverse' } })).statusCode).toBe(200);
    const reversal = String((await pool.query('SELECT id FROM gl_journal_entries WHERE reversal_of_id = $1', [journal])).rows[0]!.id);
    expect(await journalLines(reversal)).toEqual((await journalLines(journal)).map(([code, cc1, d, c]) => [code, cc1, c, d]));
  });

  it('holds the employee\'s centres BEFORE it waits for the directive row (approval\'s order)', async () => {
    const directive = await approvedDirective(f, 5000, 0.18, '2026-08-31', '2222222222');
    const cancel = await pool.connect();
    const editor = await pool.connect();
    let paying: ReturnType<typeof applyStandalone> | null = null;
    try {
      // A cancel in flight holds the directive row, as updateTaxDirective does.
      await cancel.query('BEGIN');
      await cancel.query('SELECT 1 FROM tax_directives WHERE id = $1 FOR UPDATE', [directive]);
      paying = applyStandalone(f, directive);
      await waitForDirectiveWait();
      // The payment now waits on the directive; a centre edit must already be waiting on IT.
      await editor.query("SET lock_timeout = '300ms'");
      const edit = await editor.query('UPDATE cost_centres SET name = name WHERE id = $1', [cc.a]).then(() => 'committed', (e: { code?: string }) => e.code);
      await cancel.query('COMMIT');
      expect(edit).toBe('55P03');
      expect((await paying).statusCode).toBe(200);
    } finally {
      await cancel.query('ROLLBACK').catch(() => undefined);
      await paying?.catch(() => undefined);
      cancel.release();
      editor.release();
    }
  });
});

/** Until a backend is waiting on a row lock of tax_directives. */
async function waitForDirectiveWait(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const n = (await pool.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND query ILIKE '%FROM tax_directives%FOR SHARE%'`)).rows[0]!.n;
    if (n > 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the payment never waited on the directive row');
}
