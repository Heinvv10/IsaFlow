/**
 * Audit WP2 row 9 — bank-reconciliations (start) and bank-reconciliations-action answered every unrecognised throw
 * 400 with its raw message. A 4xx COMMITs the request (withAuth), so a crash after the session was written (started,
 * cancelled) committed it. Now only the typed refusals keep their 4xx; anything else is a 500 and rolls back.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

vi.mock('@/lib/logger', async (orig) => (await import('./bank-catchall.helpers')).loggerWithFault(await orig()));
vi.mock('@/lib/neon', async (orig) => (await import('./bank-catchall.helpers')).neonWithFault(await orig()));

import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { bankCompany, cleanupBankControlsA, refusalOf, type BankCompany } from './bank-controls-a.helpers';
import { faults, resetFaults } from './bank-catchall.helpers';
import reconciliations from '../../pages/api/accounting/bank-reconciliations';
import reconciliationsAction from '../../pages/api/accounting/bank-reconciliations-action';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let a = '';
let f: BankCompany;
let other: BankCompany;

beforeAll(async () => {
  a = await createUser(pool, tokens);
  f = await bankCompany(pool, [[a, 'admin']], companies);
  other = await bankCompany(pool, [[a, 'admin']], companies);
});
beforeEach(() => resetFaults());
afterAll(async () => {
  await pool.query('UPDATE bank_transactions SET reconciliation_id = NULL WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM bank_reconciliations WHERE company_id = ANY($1)', [companies]);
  await cleanupBankControlsA(pool, companies, [a]); // ends the pool
});

const start = (bankAccountId: string, statementDate: string) => callRoute(reconciliations as never, tokens[a]!, f.c, 'POST',
  { bankAccountId, statementDate, statementBalance: 0 }, '/api/accounting/bank-reconciliations');
const action = (body: Record<string, unknown>) => callRoute(reconciliationsAction as never, tokens[a]!, f.c, 'POST', body,
  '/api/accounting/bank-reconciliations-action');
const sessionsOn = async (statementDate: string) => (await pool.query(
  'SELECT id, status FROM bank_reconciliations WHERE company_id = $1 AND statement_date = $2', [f.c, statementDate])).rows as
  { id: string; status: string }[];

describe('bank-reconciliations POST: a crash after the session is written is a 500 and rolls back', () => {
  it('the session was inserted, then a TypeError — 500, and no session is left', async () => {
    faults.afterLog = 'Started bank reconciliation';
    const res = await start(f.bank, '2026-09-10');
    expect(faults.fired).toHaveLength(1);
    expect({ status: res.state.statusCode, sessions: await sessionsOn('2026-09-10') }).toEqual({ status: 500, sessions: [] });
  });

  it('another company\'s bank account is still refused 400', async () => {
    expect(refusalOf(await start(other.bank, '2026-09-11')).status).toBe(400);
  });
});

describe('bank-reconciliations-action: a crash after the write is a 500 and rolls back', () => {
  it('cancel: the session was deleted, then a TypeError — 500, and the session is still there', async () => {
    const started = await start(f.bank, '2026-09-12');
    expect(started.state.statusCode, JSON.stringify(started.state.body)).toBe(201);
    const [session] = await sessionsOn('2026-09-12');
    faults.afterLog = 'Cancelled bank reconciliation';
    const res = await action({ action: 'cancel', reconciliationId: session!.id });
    expect(faults.fired).toHaveLength(1);
    expect({ status: res.state.statusCode, sessions: await sessionsOn('2026-09-12') })
      .toEqual({ status: 500, sessions: [{ id: session!.id, status: 'in_progress' }] });
  });

  it('the typed refusals keep their 4xx: unknown session 404, an adjustment on another bank 400, cancel unknown 400', async () => {
    expect(refusalOf(await action({ action: 'complete', reconciliationId: crypto.randomUUID() })).status).toBe(404);
    await start(f.bank, '2026-09-13');
    const [session] = await sessionsOn('2026-09-13');
    const adj = refusalOf(await action({ action: 'adjustment', reconciliationId: session!.id, bankAccountId: f.bank2,
      contraAccountId: f.expA, amount: 10, description: 'catch-all adjustment' }));
    expect(adj).toMatchObject({ status: 400, message: expect.stringMatching(/does not match the reconciliation/) });
    expect(refusalOf(await action({ action: 'cancel', reconciliationId: crypto.randomUUID() })).status).toBe(400);
  });
});
