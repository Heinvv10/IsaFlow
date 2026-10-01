/**
 * W3-01 round 6 — the payroll guard on the generic journal reversal, under contention.
 *
 *  · Its 5s lock wait used to raise the LOAN-lock error ("being calculated by another
 *    request") whoever held the run — an approve or a reopen just as well — and the MCP
 *    tool rethrew it, so an agent saw a generic failure. It has its own error now,
 *    answered 400 with its code on REST (as the other payroll lock timeouts are) and as
 *    a retryable refusal by `reverse_journal_entry`.
 *  · It locks the journal's reversal chain as well as the run header. Every writer the
 *    product has goes through the header lock first, so the chain lock is defence in
 *    depth; the last test stands in a writer that does not (a raw peer holding a chain
 *    row) to pin that the guard waits for it rather than judging past it.
 *
 * Real routes and the real MCP registry; disposable fixture DB only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { SignJWT } from 'jose';

const guard = vi.hoisted(() => ({ off: false }));
vi.mock('@/modules/accounting/services/payroll/payrollJournalReversalGuard', async (orig) => {
  const actual = await orig<typeof import('@/modules/accounting/services/payroll/payrollJournalReversalGuard')>();
  return {
    ...actual,
    refuseReversalAgainstPayRun: async (...a: Parameters<typeof actual.refuseReversalAgainstPayRun>) => {
      if (!guard.off) await actual.refuseReversalAgainstPayRun(...a);
    },
  };
});

import approve from '../../pages/api/payroll/runs/[id]/approve';
import reopen from '../../pages/api/payroll/runs/[id]/reopen';
import journalPlan from '../../pages/api/payroll/runs/[id]/journal-plan';
import jeAction from '../../pages/api/accounting/journal-entries-action';
import { mcpRegistry } from '@/lib/mcp/toolIndex';
import { withAlsTransaction } from '@/lib/alsTransaction';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { calculatedRun, cleanPayrollCompanies, routeCaller, seedPayrollCompany, type Route } from './w3-01-payroll.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const company = crypto.randomUUID();
const admin = crypto.randomUUID();
const tokens: Record<string, string> = {};
const call = routeCaller(tokens, { user: admin, company });

const url = (id: string, action: string) => `/api/payroll/runs/${id}/${action}`;
const doApprove = async (id: string) => call(approve as Route, 'POST', url(id, 'approve'), id,
  { body: { expectedPlanHash: (await call(journalPlan as Route, 'GET', url(id, 'journal-plan'), id)).body.data?.planHash } });
const doReopen = (id: string) => call(reopen as Route, 'POST', url(id, 'reopen'), id, { body: { reason: 'w301 guard locks' } });
const reverse = (journalId: string) => call(jeAction as Route, 'POST', '/api/accounting/journal-entries-action', undefined, { body: { id: journalId, action: 'reverse' } });
const contraOf = async (journalId: string) => String((await pool.query('SELECT id FROM gl_journal_entries WHERE reversal_of_id = $1', [journalId])).rows[0]!.id);
const reversedAt = async (journalId: string) => (await pool.query('SELECT reversed_at FROM gl_journal_entries WHERE id = $1', [journalId])).rows[0]!.reversed_at;

let key = 0;
async function mcpReverse(journalId: string) {
  const ctx = { userId: admin, companyId: company, scopes: ['write:journals', 'read:journals', 'write:post', 'write:payroll'], tokenJti: null, oauthAppId: null };
  key += 1;
  try {
    const res = await withAlsTransaction({ userId: admin, companyId: company },
      () => mcpRegistry.call('reverse_journal_entry', { journal_entry_id: journalId, idempotency_key: `w301-guard-${key}-${crypto.randomUUID()}` }, ctx as never)) as {
      isError?: boolean; content: Array<{ text: string }>;
    };
    return { thrown: false, isError: res.isError === true, text: res.content?.[0]?.text ?? '' };
  } catch (err) {
    return { thrown: true, isError: true, text: (err as Error).message };
  }
}

/** Run `fn` while a peer transaction holds `lockSql` (released after 9s whatever happens, so nothing hangs). */
async function whileHeld<T>(lockSql: string, params: unknown[], fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const peer: PoolClient = await pool.connect();
  const letGo = setTimeout(() => { void peer.query('ROLLBACK'); }, 9000);
  try {
    await peer.query('BEGIN');
    await peer.query(lockSql, params);
    const started = Date.now();
    const result = await fn();
    return { result, ms: Date.now() - started };
  } finally {
    clearTimeout(letGo);
    await peer.query('ROLLBACK');
    peer.release();
  }
}

/** A reopened run whose journal is in force. */
async function reopenedRun(month: number) {
  const id = await calculatedRun(call, month);
  const j1 = String((await doApprove(id)).body.data!.journalEntryId);
  expect((await doReopen(id)).statusCode).toBe(200);
  return { id, j1 };
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'W301 guard locks']);
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

const HOLD_RUN = 'SELECT id FROM payroll_run_headers WHERE id = $1 FOR UPDATE';

describe('the payroll reversal guard under contention (W3-01 round 6)', () => {
  it('REST: the run held by another request → 400, its own code, a neutral retry message, nothing written', async () => {
    const { id, j1 } = await reopenedRun(1);
    const { result: res, ms } = await whileHeld(HOLD_RUN, [id], () => reverse(j1));
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatchObject({ details: { code: 'PAYROLL_RUN_LOCK_TIMEOUT' } });
    expect(res.body.error?.message).toMatch(/being changed by another request — retry in a moment/);
    expect(res.body.error?.message).not.toMatch(/calculated/);
    expect(ms).toBeGreaterThanOrEqual(4500);
    expect(ms).toBeLessThan(8500);
    expect(await reversedAt(j1)).toBeNull();
    expect((await reverse(j1)).statusCode).toBe(200); // free again
  }, 30000);

  it('MCP reverse_journal_entry: the same wait is a retryable refusal, not a failure', async () => {
    const { id, j1 } = await reopenedRun(2);
    const { result: res } = await whileHeld(HOLD_RUN, [id], () => mcpReverse(j1));
    expect(res).toMatchObject({ thrown: false, isError: true });
    expect(res.text).toMatch(/being changed by another request — retry in a moment/);
    expect(await reversedAt(j1)).toBeNull();
    const ok = await mcpReverse(j1);
    expect(ok.isError).toBe(false);
  }, 30000);

  it('a writer holding a row of the reversal chain is waited for — the guard does not judge past it', async () => {
    // Journal J1 → its reversal C → C's reversal C2 (the amounts back in force). Building C2 needs
    // the guard off for one call, as it was before round 5; the run is reopened, so C2 is
    // reversible and nothing but a lock can stop that reversal.
    const { j1 } = await reopenedRun(3);
    expect((await reverse(j1)).statusCode).toBe(200);
    const c = await contraOf(j1);
    guard.off = true;
    try { expect((await reverse(c)).statusCode).toBe(200); } finally { guard.off = false; }
    const c2 = await contraOf(c);

    // A peer holds J1 — the chain's first row, not the journal being reversed.
    const { result: res } = await whileHeld('SELECT id FROM gl_journal_entries WHERE id = $1 FOR UPDATE', [j1], () => reverse(c2));
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatchObject({ details: { code: 'PAYROLL_RUN_LOCK_TIMEOUT' } });
    expect(await reversedAt(c2)).toBeNull();
  }, 30000);
});
