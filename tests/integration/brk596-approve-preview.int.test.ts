/**
 * BRK-596 adversarial repros (W3-01 review rounds 1–2), adopted as tests: the
 * journal-plan preview against approve, through the real routes (withAuth,
 * app_user, RLS). Each repro asserted the defect; each now asserts the fix.
 *
 * Round 2: every state is reached the way the product reaches it — runs are
 * created and costed by their routes, figures change by editing a pay
 * component and recalculating, and a journal is reversed by the real
 * reverseJournalEntry. Nothing writes a header, status or journal by hand.
 * Disposable fixture DB only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import approve from '../../pages/api/payroll/runs/[id]/approve';
import reopen from '../../pages/api/payroll/runs/[id]/reopen';
import calculate from '../../pages/api/payroll/runs/[id]/calculate';
import journalPlan from '../../pages/api/payroll/runs/[id]/journal-plan';
import runDetail from '../../pages/api/payroll/runs/[id]';
import jeAction from '../../pages/api/accounting/journal-entries-action';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { calculatedRun, cleanPayrollCompanies, routeCaller, seedPayrollCompany, type Route } from './w3-01-payroll.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companyA = crypto.randomUUID();
const companyB = crypto.randomUUID();
const admin = crypto.randomUUID();
const viewer = crypto.randomUUID();
const outsider = crypto.randomUUID();
const tokens: Record<string, string> = {};
const call = routeCaller(tokens, { user: admin, company: companyA });
let salaryA = '';

const url = (id: unknown, action: string) => `/api/payroll/runs/${String(id)}${action ? `/${action}` : ''}`;
const preview = (id: unknown, o = {}) => call(journalPlan as Route, 'GET', url(id, 'journal-plan'), id, o);
const approveRaw = (id: unknown, o: { user?: string; body?: unknown } = {}) => call(approve as Route, 'POST', url(id, 'approve'), id, o);
/** Approve as the page does: preview, then POST the previewed hash (mandatory since round 2). */
async function doApprove(id: unknown, o: { user?: string; body?: unknown } = {}) {
  const body = o.body ?? { expectedPlanHash: (await preview(id, o)).body.data?.planHash };
  return approveRaw(id, { ...o, body });
}
const doCalculate = (id: unknown, o = {}) => call(calculate as Route, 'POST', url(id, 'calculate'), id, o);
const doReopen = (id: unknown) => call(reopen as Route, 'POST', url(id, 'reopen'), id, { body: { reason: 'brk596 reopen' } });
const setSalary = (amount: number) => pool.query('UPDATE payroll_employee_components SET amount = $1 WHERE id = $2', [amount, salaryA]);

async function header(runId: string) {
  return (await pool.query('SELECT status, journal_entry_id, total_gross::float8 AS gross FROM payroll_run_headers WHERE id=$1', [runId])).rows[0]!;
}
async function journalDebit(journalId: string): Promise<number> {
  return Number((await pool.query('SELECT sum(debit)::float8 AS d FROM gl_journal_lines WHERE journal_entry_id=$1', [journalId])).rows[0]!.d);
}
async function payrollJournals(company: string, desc: string): Promise<number> {
  return (await pool.query('SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id=$1 AND description=$2', [company, desc])).rows[0]!.n;
}

beforeAll(async () => {
  for (const [id, name] of [[companyA, 'BRK596 A'], [companyB, 'BRK596 B']] as const) {
    await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [id, name]);
  }
  salaryA = await seedPayrollCompany(pool, companyA);
  await seedPayrollCompany(pool, companyB);
  for (const u of [admin, viewer, outsider]) {
    await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [u, `${u}@test.local`]);
    tokens[u] = await new SignJWT({ sub: u, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  }
  for (const c of [companyA, companyB]) await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [c, admin]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'viewer')", [companyA, viewer]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [companyB, outsider]);
});

afterAll(async () => {
  try {
    await cleanPayrollCompanies(pool, [companyA, companyB]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[admin, viewer, outsider]]);
  } finally { await pool.end(); }
});

describe('BRK-596', () => {
  it('REPRO 1: concurrent double approve posts ONE journal', async () => {
    const id = await calculatedRun(call, 1);
    await Promise.all([doApprove(id), doApprove(id), doApprove(id), doApprove(id)]);
    expect(await payrollJournals(companyA, 'Payroll run 2026-01')).toBe(1);
  });

  it('REPRO 2: stale page (a peer already approved) — the preview refuses exactly what approve refuses', async () => {
    const id = await calculatedRun(call, 2);
    expect((await doApprove(id)).statusCode).toBe(200); // peer approves
    const p = await preview(id);
    const a = await doApprove(id);
    expect(p.statusCode).toBe(200);
    expect(a.statusCode).toBe(400);
    expect(p.body.data!.blocker).toEqual({ code: 'status_not_approvable', detail: a.body.error!.message });
  });

  it('REPRO 3: a run recalculated between preview and approve is refused 409, and nothing is written', async () => {
    const id = await calculatedRun(call, 5);
    const p = await preview(id);
    await setSalary(30000);
    try {
      expect((await doCalculate(id)).statusCode).toBe(200); // another session recalculates
      const a = await doApprove(id, { body: { expectedPlanHash: p.body.data!.planHash } });
      expect(a.statusCode).toBe(409);
      expect(a.body.error!.message).toBe('Payroll run changed while you were reviewing it');
      expect(await header(id)).toMatchObject({ status: 'calculated', journal_entry_id: null, gross: 30000 });
      expect(await payrollJournals(companyA, 'Payroll run 2026-05')).toBe(0);
      // Re-reviewed: the fresh hash approves, and posts what was previewed.
      const p2 = await preview(id);
      const ok = await doApprove(id, { body: { expectedPlanHash: p2.body.data!.planHash } });
      expect(ok.statusCode).toBe(200);
      expect(await journalDebit(ok.body.data!.journalEntryId)).toBe(p2.body.data!.plan.totalDebit);
    } finally { await setSalary(20000); }
  });

  it('REPRO 3b / R2-4: a missing or non-string expectedPlanHash is a 400, and nothing is written', async () => {
    const id = await calculatedRun(call, 9);
    expect((await approveRaw(id, { body: { expectedPlanHash: ['x'] } })).statusCode).toBe(400);
    expect((await approveRaw(id, { body: {} })).statusCode).toBe(400);
    expect((await approveRaw(id)).statusCode).toBe(400);
    expect(await header(id)).toMatchObject({ status: 'calculated', journal_entry_id: null });
  });

  it('R2-3: a double submit with the same hash still posts ONE journal', async () => {
    const id = await calculatedRun(call, 3);
    const body = { expectedPlanHash: (await preview(id)).body.data!.planHash };
    const rs = await Promise.all([1, 2, 3, 4].map(() => approveRaw(id, { body })));
    expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 400, 400, 400]);
    expect(await payrollJournals(companyA, 'Payroll run 2026-03')).toBe(1);
  });

  it('REPRO 4: a reopened run recalculated after posting cannot be re-approved onto the old journal', async () => {
    const id = await calculatedRun(call, 6);
    const first = await doApprove(id);
    const je = first.body.data!.journalEntryId;
    const postedDebit = await journalDebit(je);
    expect((await doReopen(id)).statusCode).toBe(200);
    await setSalary(30000);
    try {
      expect((await doCalculate(id)).statusCode).toBe(200); // the drift is refused at approval
      const p = await preview(id);
      const again = await doApprove(id);
      expect(p.body.data!.blocker!.code).toBe('recalculated_after_posting');
      expect(again.statusCode).toBe(400);
      expect(again.body.error!.message).toBe(p.body.data!.blocker!.detail);
      expect(await header(id)).toMatchObject({ status: 'calculated', gross: 30000 });
      expect(await journalDebit(je)).toBe(postedDebit);
    } finally { await setSalary(20000); }
  });

  it('REPRO 4b: a reopened run NOT recalculated shows the posted journal and re-locks onto it', async () => {
    const id = await calculatedRun(call, 10);
    const je = (await doApprove(id)).body.data!.journalEntryId;
    expect((await doReopen(id)).statusCode).toBe(200);
    const p = await preview(id);
    expect(p.body.data!.blocker).toBeNull();
    expect(p.body.data!.posted).toMatchObject({ journalEntryId: je, totalDebit: await journalDebit(je) });
    const again = await doApprove(id, { body: { expectedPlanHash: p.body.data!.planHash } });
    expect(again.statusCode).toBe(200);
    expect(again.body.data!.journalEntryId).toBe(je);
    expect(await payrollJournals(companyA, 'Payroll run 2026-10')).toBe(1);
  });

  // Breaker round 3 (A): refusing here left the month a dead end — nothing
  // reachable unlinked the reversed journal. It is replaced instead; only a
  // reversal that was itself reversed (amounts re-booked) is still refused.
  it('REPRO 4c: a reopened run whose journal was reversed in the GL is never re-locked onto it', async () => {
    const id = await calculatedRun(call, 11);
    const je = (await doApprove(id)).body.data!.journalEntryId;
    expect((await doReopen(id)).statusCode).toBe(200);
    const contra = await reverseJournalEntry(companyA, je, admin); // the GL's own reversal: status stays 'posted'
    const p = await preview(id);
    expect(p.body.data!.blocker).toBeNull();
    expect(p.body.data!.posted).toBeNull();
    expect(p.body.data!.replaces).toMatchObject({ journalEntryId: je });

    // Round 5: reversing the reversal would re-book the old amounts beside the
    // replacement approval posts, so the reversal itself refuses it.
    await expect(reverseJournalEntry(companyA, contra.id, admin)).rejects.toThrow(/approve the pay run/);
    expect((await preview(id)).body.data!.replaces).toMatchObject({ journalEntryId: je });
    expect(await header(id)).toMatchObject({ status: 'calculated', journal_entry_id: je });
    expect(await payrollJournals(companyA, 'Payroll run 2026-11')).toBe(1);
  });

  it('R2-1: a journal reversed through POST /api/accounting/journal-entries-action is not live, and is replaced', async () => {
    const id = await calculatedRun(call, 12);
    const je = (await doApprove(id)).body.data!.journalEntryId;
    expect((await doReopen(id)).statusCode).toBe(200);
    const rev = await call(jeAction as Route, 'POST', '/api/accounting/journal-entries-action', undefined, { body: { id: je, action: 'reverse' } });
    expect(rev.statusCode).toBe(200);
    const p = await preview(id);
    expect(p.body.data!.blocker).toBeNull();
    expect(p.body.data!.replaces).toMatchObject({ journalEntryId: je });
    const again = await doApprove(id);
    expect(again.statusCode).toBe(200);
    expect(again.body.data!.journalEntryId).not.toBe(je);
    expect(await header(id)).toMatchObject({ status: 'approved', journal_entry_id: again.body.data!.journalEntryId });
    expect(await payrollJournals(companyA, 'Payroll run 2026-12')).toBe(2); // the reversed one and its replacement
  });

  it('REPRO 5: cross-tenant and malformed ids', async () => {
    const foreign = await calculatedRun(call, 7, { company: companyB });
    expect((await preview(foreign)).statusCode).toBe(404); // admin, active company A, B's run
    expect((await preview(foreign, { user: outsider, company: companyA })).statusCode).toBeGreaterThanOrEqual(401);
    expect((await preview([foreign, foreign])).statusCode).toBe(400);
    expect((await preview("x' OR 1=1--")).statusCode).toBe(400);
  });

  it('REPRO 6: a viewer can neither preview, approve nor recalculate', async () => {
    const id = await calculatedRun(call, 8);
    const before = await header(id);
    expect((await preview(id, { user: viewer })).statusCode).toBe(403);
    expect((await doApprove(id, { user: viewer })).statusCode).toBe(403);
    expect((await doCalculate(id, { user: viewer })).statusCode).toBe(403);
    expect(await header(id)).toEqual(before);
    // D3 (owner's ruling 2026-10-02): per-employee figures are for write roles; a viewer gets 403 on the run detail.
    expect((await call(runDetail as Route, 'GET', url(id, ''), id, { user: viewer })).statusCode).toBe(403);
  });
});
