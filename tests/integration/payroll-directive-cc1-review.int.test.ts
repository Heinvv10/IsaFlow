/**
 * Review of PR #1073 (a SARS directive's labour split and CC1-tagged like a
 * pay run). A directive payment must never be blocked by mapping or tagging,
 * and must post the split as it stands when it is written:
 *
 *  1. a centre mapped to a DEACTIVATED account posts to the default labour
 *     account (5200), keeping its CC1, with `labour_account_inactive` — the
 *     parent branch posted it to 5200 too; head 08639a645 answered 500;
 *  2. the split is re-read AFTER the directive-row wait: an allocation or
 *     mapping edit committed meanwhile is what posts. A split that now names a
 *     centre the payment did not lock first is refused with a retryable 409
 *     (TAX_DIRECTIVE_SPLIT_CHANGED), nothing written;
 *  3. an unapproved directive is refused before any centre lock is waited for;
 *  4. the advisory never prints another company's centre id.
 *
 * Real routes (withAuth, app_user, RLS) on the disposable fixture.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { applyStandalone, approvedDirective, cleanSeveranceFixtures, seedRetrenchedEmployee, type SeveranceFixture } from './p3-severance.helpers';
import { createTaxDirective } from '@/modules/accounting/services/payroll/taxDirectiveService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let f: SeveranceFixture;
let acct5210 = '';
const cc = { a: crypto.randomUUID(), b: crypto.randomUUID(), c: crypto.randomUUID() };
let seq = 0;
const number = () => `77${String(++seq).padStart(8, '0')}`;

const labour = async (journalId: string) => (await pool.query(
  `SELECT a.account_code, l.cc1_id::text AS cc1, round(l.debit * 100)::int AS d
     FROM gl_journal_lines l JOIN gl_accounts a ON a.id = l.gl_account_id
    WHERE l.journal_entry_id = $1 AND l.debit > 0 ORDER BY a.account_code, l.cc1_id NULLS LAST`, [journalId])).rows.map((r) => [r.account_code, r.cc1, r.d]);
const allocate = async (shares: Array<[string, number]>) => {
  await pool.query('DELETE FROM payroll_employee_cost_allocations WHERE company_id = $1', [f.company]);
  for (const [id, pct] of shares) {
    await pool.query('INSERT INTO payroll_employee_cost_allocations (company_id, employee_id, cost_centre_id, percentage) VALUES ($1,$2,$3,$4)',
      [f.company, f.employee, id, pct]);
  }
};
const map = async (centre: string, account: string | null) => {
  await pool.query('DELETE FROM cost_centre_gl_mappings WHERE company_id = $1 AND cost_centre_id = $2', [f.company, centre]);
  if (account) await pool.query('INSERT INTO cost_centre_gl_mappings (company_id, cost_centre_id, expense_account_id) VALUES ($1,$2,$3)', [f.company, centre, account]);
};
const payments = async (directive: string) => Number((await pool.query(
  'SELECT count(*)::int AS n FROM tax_directive_payments WHERE tax_directive_id = $1', [directive])).rows[0]!.n);

/** Pays `directive` while a peer holds its row (a cancel in flight); `meanwhile` runs once the payment waits on it. */
async function payWhileDirectiveHeld(directive: string, meanwhile: () => Promise<void>) {
  const peer = await pool.connect();
  try {
    await peer.query('BEGIN');
    await peer.query('SELECT 1 FROM tax_directives WHERE id = $1 FOR UPDATE', [directive]);
    const paying = applyStandalone(f, directive);
    for (let i = 0; ; i++) {
      const n = (await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND query ILIKE '%FROM tax_directives%FOR SHARE%'`)).rows[0]!.n;
      if (n > 0) break;
      if (i > 100) throw new Error('the payment never waited on the directive row');
      await new Promise((r) => setTimeout(r, 50));
    }
    await meanwhile();
    await peer.query('ROLLBACK');
    return await paying;
  } finally {
    await peer.query('ROLLBACK').catch(() => undefined);
    peer.release();
  }
}

beforeAll(async () => {
  f = await seedRetrenchedEmployee(pool, '2026-08-31', 'cc1 directive review');
  acct5210 = (await pool.query(
    `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level)
     VALUES ($1,'5210','Site labour','expense','debit',1) RETURNING id`, [f.company])).rows[0]!.id;
  for (const [id, code] of [[cc.a, 'REV-A'], [cc.b, 'REV-B'], [cc.c, 'REV-C']] as const) {
    await pool.query("INSERT INTO cost_centres (id, company_id, code, name, cc_type, is_active) VALUES ($1,$2,$3,$3,'cc1',true)", [id, f.company, code]);
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

describe('a directive payment is never blocked by mapping or tagging', () => {
  it('a centre mapped to a deactivated account posts to 5200, keeps its CC1, and says so', async () => {
    await allocate([[cc.a, 100]]);
    await map(cc.a, acct5210);
    await pool.query('UPDATE gl_accounts SET is_active = false WHERE id = $1', [acct5210]);
    try {
      const paid = await applyStandalone(f, await approvedDirective(f, 1000, 0.18, '2026-08-31', number()));
      expect(paid.statusCode).toBe(200);
      expect(await labour(String(paid.body.data!.journalEntryId))).toEqual([['5200', cc.a, 100000]]);
      const advisory = (paid.body.data!.advisories as Array<{ code: string; detail: string }>).find((a) => a.code === 'labour_account_inactive');
      expect(advisory?.detail).toContain('5210');
    } finally {
      await pool.query('UPDATE gl_accounts SET is_active = true WHERE id = $1', [acct5210]);
    }
  });

  it('the advisory names no centre of another company', async () => {
    const other = crypto.randomUUID();
    const foreign = crypto.randomUUID();
    await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [other, 'cc1 review other']);
    await pool.query("INSERT INTO cost_centres (id, company_id, code, name, cc_type, is_active) VALUES ($1,$2,'FOREIGN','FOREIGN','cc1',true)", [foreign, other]);
    try {
      await allocate([[foreign, 100]]);
      const paid = await applyStandalone(f, await approvedDirective(f, 500, 0.18, '2026-08-31', number()));
      expect(paid.statusCode).toBe(200);
      expect(await labour(String(paid.body.data!.journalEntryId))).toEqual([['5200', null, 50000]]);
      expect(JSON.stringify(paid.body.data!.advisories)).not.toContain(foreign);
      expect(JSON.stringify(paid.body.data!.advisories)).not.toContain('FOREIGN');
    } finally {
      await pool.query('DELETE FROM payroll_employee_cost_allocations WHERE company_id = $1', [f.company]);
      await pool.query('DELETE FROM cost_centres WHERE id = $1', [foreign]);
      await pool.query('DELETE FROM companies WHERE id = $1', [other]);
    }
  });
});

describe('the split is the one standing when the payment is written', () => {
  it('an allocation + mapping edit committed while the payment waits on the directive is what posts', async () => {
    await allocate([[cc.a, 33.33], [cc.b, 66.67]]);
    await map(cc.a, acct5210);
    await map(cc.b, null);
    const directive = await approvedDirective(f, 1000, 0.18, '2026-08-31', number());
    const paid = await payWhileDirectiveHeld(directive, async () => {
      await allocate([[cc.b, 100]]);
      await map(cc.b, acct5210);
    });
    expect(paid.statusCode).toBe(200);
    expect(await labour(String(paid.body.data!.journalEntryId))).toEqual([['5210', cc.b, 100000]]);
  });

  it('a split that grew a centre while waiting is refused with a retryable 409, nothing written; the retry posts it', async () => {
    await allocate([[cc.a, 100]]);
    await map(cc.c, null);
    const directive = await approvedDirective(f, 1000, 0.18, '2026-08-31', number());
    const refused = await payWhileDirectiveHeld(directive, async () => { await allocate([[cc.a, 50], [cc.c, 50]]); });
    expect(refused.statusCode).toBe(409);
    expect(JSON.stringify(refused.body)).toContain('TAX_DIRECTIVE_SPLIT_CHANGED');
    expect(await payments(directive)).toBe(0);
    const retried = await applyStandalone(f, directive);
    expect(retried.statusCode).toBe(200);
    expect(await labour(String(retried.body.data!.journalEntryId))).toEqual([['5200', cc.c, 50000], ['5210', cc.a, 50000]]);
  });

  it('an unapproved directive is refused without waiting for a centre lock', async () => {
    await allocate([[cc.a, 100]]);
    const pending = await createTaxDirective(f.company, {
      employee_id: f.employee, employee_name: 'Wanda Test', directive_number: number(), directive_type: 'severance',
      amount: 1000, tax_rate: 0.18, effective_date: '2026-08-31',
    }, f.admin);
    const editor = await pool.connect();
    try {
      await editor.query('BEGIN');
      await editor.query('UPDATE cost_centres SET name = name WHERE id = $1', [cc.a]); // a dimension edit in flight
      const outcome = await Promise.race([
        applyStandalone(f, pending.id).then((r) => r.statusCode),
        new Promise((r) => setTimeout(() => r('waited'), 3000)),
      ]);
      expect(outcome).toBe(409);
    } finally {
      await editor.query('ROLLBACK').catch(() => undefined);
      editor.release();
    }
  });
});
