/**
 * W3-01 round 5 — reversal links that do not form a chain that ends.
 *
 * Bad data, or a forged `reversal_of_id`: A reversed by B and B by A; a
 * journal that reverses itself. Every path that reads or locks a pay run's
 * reversal chain must answer promptly with a REFUSAL and write nothing — the
 * recursive queries are capped (MAX_CHAIN_JOURNALS), so Postgres does not walk
 * the loop for ever. The links are forged here by hand; nothing in the product
 * writes them. Real routes; disposable fixture DB only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import approve from '../../pages/api/payroll/runs/[id]/approve';
import reopen from '../../pages/api/payroll/runs/[id]/reopen';
import calculate from '../../pages/api/payroll/runs/[id]/calculate';
import journalPlan from '../../pages/api/payroll/runs/[id]/journal-plan';
import jeAction from '../../pages/api/accounting/journal-entries-action';
import { findChainRoot, readJournalChain } from '@/modules/accounting/services/payroll/payrollJournalChain';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { calculatedRun, cleanPayrollCompanies, routeCaller, seedPayrollCompany, type Route } from './w3-01-payroll.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const company = crypto.randomUUID();
const admin = crypto.randomUUID();
const tokens: Record<string, string> = {};
const call = routeCaller(tokens, { user: admin, company });

const url = (id: string, action: string) => `/api/payroll/runs/${id}/${action}`;
const preview = (id: string) => call(journalPlan as Route, 'GET', url(id, 'journal-plan'), id);
const doApprove = async (id: string) => call(approve as Route, 'POST', url(id, 'approve'), id, { body: { expectedPlanHash: (await preview(id)).body.data?.planHash } });
const reverse = (journalId: string) => call(jeAction as Route, 'POST', '/api/accounting/journal-entries-action', undefined, { body: { id: journalId, action: 'reverse' } });
/** Approve and reopen: the run links j1. With `reversed`, j1 is then reversed by a contra. */
async function reopenedRun(month: number, reversed: boolean) {
  const id = await calculatedRun(call, month);
  const j1 = String((await doApprove(id)).body.data!.journalEntryId);
  expect((await call(reopen as Route, 'POST', url(id, 'reopen'), id, { body: { reason: 'w301 forged links' } })).statusCode).toBe(200);
  if (!reversed) return { id, j1, journals: [j1] };
  expect((await reverse(j1)).statusCode).toBe(200);
  const contra = String((await pool.query('SELECT id FROM gl_journal_entries WHERE reversal_of_id = $1', [j1])).rows[0]!.id);
  return { id, j1, journals: [j1, contra] };
}
const journalCount = async () => (await pool.query('SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id = $1', [company])).rows[0]!.n as number;

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'W301 forged links']);
  await seedPayrollCompany(pool, company);
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

describe('a pay run\'s journal whose reversal links loop (W3-01 round 5)', () => {
  it.each([
    // The contra already reverses j1; pointing j1 back at the contra closes the loop.
    ['A reversed by B, B reversed by A', 1, true],
    // (One journal may be reversed by only one other — ux_gl_je_reversal_of — so this one has no contra.)
    ['a journal that reverses itself', 2, false],
  ] as const)('%s: preview, approve, calculate and reverse all answer, refuse and post nothing', async (_name, month, reversed) => {
    const { id, j1, journals } = await reopenedRun(month, reversed);
    await pool.query('UPDATE gl_journal_entries SET reversal_of_id = $2 WHERE id = $1', [j1, journals[journals.length - 1]]);
    const journalsBefore = await journalCount();
    const started = Date.now();

    // Both walks stop by themselves — asked directly, because the reversal route answers 400 to ANY error.
    for (const journal of journals) expect(await findChainRoot(company, journal)).toBeNull();
    const chain = await readJournalChain(company, j1);
    expect(chain).toMatchObject({ broken: true, state: 'unclear' });
    expect(chain!.journals.length).toBeLessThanOrEqual(2);

    const p = await preview(id);
    expect(p.statusCode).toBe(200);
    expect(p.body.data!.blocker).toMatchObject({ code: 'posted_journal_not_live' });
    expect(p.body.data!.blocker.detail).toMatch(/do not form a chain that ends/);
    expect(p.body.data!.replaces).toBeNull();
    expect((await doApprove(id)).statusCode).toBe(400);
    expect((await call(calculate as Route, 'POST', url(id, 'calculate'), id)).statusCode).toBe(200); // no loan work: nothing to guard
    for (const journal of journals) expect((await reverse(journal)).statusCode).toBe(400);
    expect(Date.now() - started).toBeLessThan(10000);

    // The calculate rewrote the run's lines; no journal was posted, reversed or unlinked.
    expect((await pool.query('SELECT status, journal_entry_id FROM payroll_run_headers WHERE id = $1', [id])).rows[0])
      .toEqual({ status: 'calculated', journal_entry_id: j1 });
    expect(await journalCount()).toBe(journalsBefore);
    expect((await pool.query('SELECT count(*)::int AS n FROM gl_journal_entries WHERE id = ANY($1) AND reversed_at IS NOT NULL', [journals])).rows[0]!.n)
      .toBe(reversed ? 1 : 0);
  }, 30000);
});
