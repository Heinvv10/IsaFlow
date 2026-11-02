/**
 * The approval gate on a reopened, RECALCULATED run whose journal's CC1 tags
 * no longer read like today's plan although no figure changed (review of PR
 * #1065; REPRO 1/2 are the breaker's, ported). Labour is compared per
 * (account, CC1) for such a run, so:
 *
 *  1. a journal posted BEFORE labour lines carried CC1 (every labour line
 *     cc1_id NULL) cannot prove its labour belonged to today's tagged centres,
 *     so it fails closed and requires reversal and reposting;
 *  2. a posted CC1 that is no longer taggable (deactivated since, or no longer
 *     a CC1) is compared as untagged, as today's plan books that centre.
 *
 * Also: a reversal after the centre was deactivated still mirrors its CC1, and
 * the plan's cost-centre read holds FOR SHARE, so a deactivation cannot commit
 * between the plan and the GL's own check in the same approval transaction.
 * Real routes (withAuth, app_user, RLS) on the disposable fixture.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withAlsTransaction } from '@/lib/alsTransaction';
import { buildPayrollJournalPlan } from '@/modules/accounting/services/payroll/payrollJournalBuilder';
import { rig } from './brkr.helpers';

let r: Awaited<ReturnType<typeof rig>>;
let acct5210 = '';
const cc = { a: crypto.randomUUID(), b: crypto.randomUUID() };
const setActive = (id: string, active: boolean) => r.pool.query('UPDATE cost_centres SET is_active = $1 WHERE id = $2', [active, id]);

beforeAll(async () => {
  r = await rig('cc1gate'); await r.setup();
  acct5210 = await r.account('5210');
  for (const [id, code] of [[cc.a, 'GATE-A'], [cc.b, 'GATE-B']] as const) {
    await r.pool.query("INSERT INTO cost_centres (id, company_id, code, name, cc_type, is_active) VALUES ($1,$2,$3,$3,'cc1',true)", [id, r.company, code]);
    await r.pool.query('INSERT INTO cost_centre_gl_mappings (company_id, cost_centre_id, expense_account_id) VALUES ($1,$2,$3)', [r.company, id, acct5210]);
  }
  const e1 = (await r.employee(20000)).employee;
  const e2 = (await r.employee(15000)).employee;
  await r.pool.query('UPDATE payroll_employees SET cost_centre_id = $1 WHERE id = $2', [cc.a, e1]);
  await r.pool.query('UPDATE payroll_employees SET cost_centre_id = $1 WHERE id = $2', [cc.b, e2]);
});
afterAll(async () => { await r.teardown(); });

describe('the gate on a recalculated run whose journal\'s CC1 no longer matches though no figure changed', () => {
  it('a pre-CC1 (untagged) journal cannot re-lock onto a recalculated tagged plan', async () => {
    const id = await r.calculatedRun(6);
    const approved = await r.api.approve(id);
    expect(approved.statusCode).toBe(200);
    const j = String(approved.body.data!.journalEntryId);
    // What every journal posted before labour lines carried CC1 looks like: identical lines, cc1_id NULL.
    await r.pool.query('UPDATE gl_journal_lines SET cc1_id = NULL WHERE journal_entry_id = $1', [j]);
    const perAccount = (await r.pool.query(
      `SELECT a.account_code, sum(l.debit)::float8 AS d FROM gl_journal_lines l JOIN gl_accounts a ON a.id = l.gl_account_id
        WHERE l.journal_entry_id = $1 AND l.debit > 0 GROUP BY 1 ORDER BY 1`, [j])).rows;
    expect((await r.api.reopen(id)).statusCode).toBe(200);
    expect((await r.api.calculate(id)).statusCode).toBe(200);
    const p = await r.api.preview(id);
    const planPerAccount = Object.entries((p.body.data!.plan.lines as Array<{ accountCode: string; debit: number }>)
      .filter((l) => l.debit > 0).reduce<Record<string, number>>((m, l) => ({ ...m, [l.accountCode]: (m[l.accountCode] ?? 0) + l.debit }), {}))
      .map(([account_code, d]) => ({ account_code, d })).sort((x, y) => x.account_code.localeCompare(y.account_code));
    expect(planPerAccount).toEqual(perAccount);
    expect(p.body.data!.blocker).toMatchObject({ code: 'recalculated_after_posting' });
  });

  it('a centre deactivated after posting leaves an unchanged recalculated run approvable onto its journal', async () => {
    const id = await r.calculatedRun(7);
    const j = String((await r.api.approve(id)).body.data!.journalEntryId);
    expect((await r.api.reopen(id)).statusCode).toBe(200);
    await setActive(cc.b, false);
    try {
      expect((await r.api.calculate(id)).statusCode).toBe(200);
      const p = await r.api.preview(id);
      expect(p.body.data!.blocker).toBeNull();
      expect((await r.api.approve(id)).body.data).toMatchObject({ journalEntryId: j });
    } finally {
      await setActive(cc.b, true);
    }
  });

  it('a real move between two centres on one account is still refused once the journal carries CC1', async () => {
    const id = await r.calculatedRun(8);
    expect((await r.api.approve(id)).statusCode).toBe(200);
    expect((await r.api.reopen(id)).statusCode).toBe(200);
    // Swap the two employees' centres: same account, same total, the CC1 split moves R5 000.
    await r.pool.query('UPDATE payroll_employees SET cost_centre_id = CASE WHEN cost_centre_id = $1 THEN $2::uuid ELSE $1::uuid END WHERE company_id = $3',
      [cc.a, cc.b, r.company]);
    try {
      expect((await r.api.calculate(id)).statusCode).toBe(200);
      expect((await r.api.preview(id)).body.data!.blocker).toMatchObject({ code: 'recalculated_after_posting' });
    } finally {
      await r.pool.query('UPDATE payroll_employees SET cost_centre_id = CASE WHEN cost_centre_id = $1 THEN $2::uuid ELSE $1::uuid END WHERE company_id = $3',
        [cc.a, cc.b, r.company]);
    }
  });
});

describe('after posting', () => {
  it('a reversal after the centre is deactivated mirrors every (account, CC1) line', async () => {
    const id = await r.calculatedRun(9);
    const j = String((await r.api.approve(id)).body.data!.journalEntryId);
    await setActive(cc.a, false);
    try {
      expect((await r.api.reopen(id)).statusCode).toBe(200);
      expect((await r.api.reverse(j)).statusCode).toBe(200);
      const q = (jid: string) => r.pool.query(
        'SELECT gl_account_id, cc1_id::text AS c, debit::float8 AS d, credit::float8 AS k FROM gl_journal_lines WHERE journal_entry_id = $1 ORDER BY 1, 2', [jid]);
      const orig = (await q(j)).rows;
      const rev = (await q(await r.contraOf(j))).rows;
      expect(rev.map((l) => [l.gl_account_id, l.c, l.k, l.d])).toEqual(orig.map((l) => [l.gl_account_id, l.c, l.d, l.k]));
      expect(orig.some((l) => l.c === cc.a)).toBe(true);
    } finally { await setActive(cc.a, true); }
  });

  it('the plan holds its centres FOR SHARE: a deactivation waits for the approval transaction', async () => {
    const id = await r.calculatedRun(10);
    const peer = await r.pool.connect();
    try {
      await peer.query("SET lock_timeout = '300ms'");
      const outcome = await withAlsTransaction({ companyId: r.company, userId: r.admin }, async () => {
        await buildPayrollJournalPlan(r.company, id);
        return peer.query('UPDATE cost_centres SET is_active = false WHERE id = $1', [cc.b]).then(() => 'committed', (e: { code?: string }) => e.code);
      });
      expect(outcome).toBe('55P03');
    } finally {
      await peer.query('UPDATE cost_centres SET is_active = true WHERE id = $1', [cc.b]);
      peer.release();
    }
  });
});
