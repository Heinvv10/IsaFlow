/**
 * W3-01 breaker round 3, A — a month must not become permanently unapprovable.
 *
 * approve → reopen → pay change → calculate left the run refused as
 * `recalculated_after_posting: reverse the posted journal first`. Doing exactly
 * that (POST /api/accounting/journal-entries-action) then left it refused as
 * `posted_journal_not_live`, for ever: the run still linked the reversed
 * journal, nothing reachable cleared the link, and a new run for the month is
 * a duplicate (409).
 *
 * Now a run whose linked journal has been reversed — and whose reversal still
 * stands — is approved onto a FRESH journal: approval, under the header lock,
 * drops the link and posts the plan. The run can never end with two live
 * journals: a reversal that was itself reversed has re-booked the amounts, and
 * that stays refused. Real routes (withAuth, app_user, RLS); disposable DB.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import approve from '../../pages/api/payroll/runs/[id]/approve';
import reopen from '../../pages/api/payroll/runs/[id]/reopen';
import calculate from '../../pages/api/payroll/runs/[id]/calculate';
import journalPlan from '../../pages/api/payroll/runs/[id]/journal-plan';
import createRun from '../../pages/api/payroll/runs';
import jeAction from '../../pages/api/accounting/journal-entries-action';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { calculatedRun, cleanPayrollCompanies, routeCaller, seedPayrollCompany, type Route } from './w3-01-payroll.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const company = crypto.randomUUID();
const admin = crypto.randomUUID();
const tokens: Record<string, string> = {};
const call = routeCaller(tokens, { user: admin, company });
let salary = '';

const url = (id: string, action: string) => `/api/payroll/runs/${id}/${action}`;
const preview = (id: string) => call(journalPlan as Route, 'GET', url(id, 'journal-plan'), id);
const approveWith = (id: string, expectedPlanHash: unknown) => call(approve as Route, 'POST', url(id, 'approve'), id, { body: { expectedPlanHash } });
const doApprove = async (id: string) => approveWith(id, (await preview(id)).body.data?.planHash);
const doReopen = (id: string) => call(reopen as Route, 'POST', url(id, 'reopen'), id, { body: { reason: 'w301 reversed journal' } });
const doCalculate = (id: string) => call(calculate as Route, 'POST', url(id, 'calculate'), id);
const reverse = (journalId: string) => call(jeAction as Route, 'POST', '/api/accounting/journal-entries-action', undefined, { body: { id: journalId, action: 'reverse' } });
const setSalary = (amount: number) => pool.query('UPDATE payroll_employee_components SET amount = $1 WHERE id = $2', [amount, salary]);

const header = async (id: string) => (await pool.query(
  'SELECT status, journal_entry_id, total_gross::float8 AS gross FROM payroll_run_headers WHERE id = $1', [id])).rows[0]!;
/** Payroll journals of the period that are in force: posted, not reversed, and not themselves a reversal. */
const liveJournals = async (description: string) => (await pool.query(
  `SELECT id FROM gl_journal_entries
    WHERE company_id = $1 AND description = $2 AND status = 'posted' AND reversed_at IS NULL AND reversal_of_id IS NULL`,
  [company, description])).rows.map((r) => String(r.id));
/** What the ledger holds on the labour account from these journals and their reversals, net. */
const labourInLedger = async (journals: string[]) => Number((await pool.query(
  `SELECT COALESCE(sum(l.debit - l.credit), 0)::float8 AS n
     FROM gl_journal_lines l
     JOIN gl_journal_entries e ON e.id = l.journal_entry_id
     JOIN gl_accounts a ON a.id = l.gl_account_id
    WHERE e.company_id = $1 AND e.status = 'posted' AND a.account_code = '5200'
      AND (e.id = ANY($2::uuid[]) OR e.reversal_of_id = ANY($2::uuid[]))`,
  [company, journals])).rows[0]!.n);

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'W301 reversed journal']);
  salary = await seedPayrollCompany(pool, company);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [admin, `${admin}@test.local`]);
  tokens[admin] = await new SignJWT({ sub: admin, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, admin]);
});

afterAll(async () => {
  try {
    await cleanPayrollCompanies(pool, [company]);
    await pool.query('DELETE FROM users WHERE id = $1', [admin]);
  } finally { await pool.end(); }
});

describe('a reopened run whose journal was reversed (W3-01 breaker A)', () => {
  it('the full round trip ends approved on ONE fresh journal carrying the new figures', async () => {
    const id = await calculatedRun(call, 1);
    const first = await doApprove(id);
    expect(first.statusCode).toBe(200);
    const j1 = String(first.body.data!.journalEntryId);
    expect((await doReopen(id)).statusCode).toBe(200);
    await setSalary(30000);
    expect((await doCalculate(id)).statusCode).toBe(200);

    // The live journal carries the old figures: the user is told to reverse it.
    const told = await preview(id);
    expect(told.body.data!.blocker).toMatchObject({ code: 'recalculated_after_posting' });
    expect((await approveWith(id, told.body.data!.planHash)).statusCode).toBe(400);

    // They do — and the month is not a dead end. A new run for it is refused…
    expect((await reverse(j1)).statusCode).toBe(200);
    expect((await call(createRun as Route, 'POST', '/api/payroll/runs', undefined, { body: { month: 1, year: 2026 } })).statusCode).toBe(409);
    expect((await doCalculate(id)).statusCode).toBe(200);

    // …so the run itself must be approvable, and the preview must say what approving does.
    const p = await preview(id);
    expect(p.body.data!.blocker).toBeNull();
    expect(p.body.data!.posted).toBeNull();
    expect(p.body.data!.replaces).toMatchObject({ journalEntryId: j1 });
    expect(p.body.data!.planHash).not.toBe(told.body.data!.planHash);
    // The hash previewed while the old journal was live does not approve this.
    expect((await approveWith(id, told.body.data!.planHash)).statusCode).toBe(409);
    expect(await header(id)).toMatchObject({ status: 'calculated', journal_entry_id: j1 });

    const again = await approveWith(id, p.body.data!.planHash);
    expect(again.statusCode).toBe(200);
    const j2 = String(again.body.data!.journalEntryId);
    expect(j2).not.toBe(j1);
    expect(await header(id)).toEqual({ status: 'approved', journal_entry_id: j2, gross: 30000 });
    // One journal in force, and the ledger holds the new labour cost once.
    expect(await liveJournals('Payroll run 2026-01')).toEqual([j2]);
    expect(await labourInLedger([j1, j2])).toBe(p.body.data!.plan.totalDebit);
    expect(p.body.data!.plan.totals.gross).toBe(30000);

    // A retry of the same approval posts nothing more.
    expect((await approveWith(id, p.body.data!.planHash)).statusCode).toBe(400);
    expect(await liveJournals('Payroll run 2026-01')).toEqual([j2]);
    await setSalary(20000);
  });

  it('a reversal that was itself reversed has re-booked the amounts: no second journal', async () => {
    const id = await calculatedRun(call, 2);
    const j1 = String((await doApprove(id)).body.data!.journalEntryId);
    expect((await doReopen(id)).statusCode).toBe(200);
    const contra = await reverse(j1);
    expect(contra.statusCode).toBe(200);
    const contraId = String((await pool.query('SELECT id FROM gl_journal_entries WHERE reversal_of_id = $1', [j1])).rows[0]!.id);
    expect((await reverse(contraId)).statusCode).toBe(200);

    const p = await preview(id);
    expect(p.body.data!.blocker).toMatchObject({ code: 'posted_journal_not_live' });
    expect(p.body.data!.replaces).toBeNull();
    expect((await approveWith(id, p.body.data!.planHash)).statusCode).toBe(400);
    expect(await header(id)).toMatchObject({ status: 'calculated', journal_entry_id: j1 });
    // The amounts are in the ledger exactly once (j1 − contra + its reversal), and no payroll journal was added.
    const n = (await pool.query(
      "SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id = $1 AND source = 'auto_payroll' AND description = 'Payroll run 2026-02'", [company])).rows[0]!.n;
    expect(n).toBe(1);
  });
});
