/**
 * Audit WP2 row 9 — bank-transactions-action and bank-transactions-import-classified answered every unrecognised
 * throw 400 with its raw message. A 4xx COMMITs the request (withAuth), so a crash after the first write committed
 * the half-done request. Now only the typed refusals keep their 4xx; anything else is a 500 and rolls back.
 *
 * Each crash is injected AFTER the write (bank-catchall.helpers), through the real route and the real withAuth.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

vi.mock('@/lib/logger', async (orig) => (await import('./bank-catchall.helpers')).loggerWithFault(await orig()));
vi.mock('@/lib/neon', async (orig) => (await import('./bank-catchall.helpers')).neonWithFault(await orig()));

import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { actionRoute, bankCompany, cleanupBankControlsA, plantLine, refusalOf, type BankCompany } from './bank-controls-a.helpers';
import { faults, resetFaults } from './bank-catchall.helpers';
import importClassified from '../../pages/api/accounting/bank-transactions-import-classified';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let a = '';
let f: BankCompany;
let other: BankCompany;
let act: ReturnType<typeof actionRoute>;

beforeAll(async () => {
  a = await createUser(pool, tokens);
  f = await bankCompany(pool, [[a, 'admin']], companies);
  other = await bankCompany(pool, [[a, 'admin']], companies);
  act = actionRoute(tokens);
});
beforeEach(() => resetFaults());
afterAll(async () => {
  await pool.query('DELETE FROM bank_transactions WHERE company_id = ANY($1)', [companies]);
  await cleanupBankControlsA(pool, companies, [a]); // ends the pool
});

const exists = async (id: string) => (await pool.query('SELECT 1 FROM bank_transactions WHERE id = $1', [id])).rowCount === 1;

describe('bank-transactions-action: a crash after the write is a 500 and rolls back', () => {
  it('delete: the DELETE ran, then a TypeError — 500, and the line is still there', async () => {
    const line = await plantLine(pool, f, null, -120);
    faults.afterSql = /DELETE FROM bank_transactions/;
    const res = await act(a, f.c, { action: 'delete', bankTransactionId: line });
    expect(faults.fired).toHaveLength(1);
    expect({ status: res.state.statusCode, kept: await exists(line) }).toEqual({ status: 500, kept: true });
  });

  it('the typed refusals keep their 4xx: a missing line is 404, a split that does not add up is 400', async () => {
    const missing = crypto.randomUUID();
    expect(refusalOf(await act(a, f.c, { action: 'exclude', bankTransactionId: missing })).status).toBe(404);
    const line = await plantLine(pool, f, null, -100);
    const split = refusalOf(await act(a, f.c, { action: 'split_allocate', bankTransactionId: line,
      lines: [{ contraAccountId: f.expA, amount: 60 }, { contraAccountId: f.expB, amount: 30 }] }));
    expect(split.status).toBe(400);
    expect(split.message).toMatch(/does not equal transaction amount/);
  });
});

describe('bank-transactions-import-classified: a crash after the insert is a 500 and rolls back', () => {
  const importAs = (company: string, bankAccountId: string, description: string) => callRoute(
    importClassified as never, tokens[a]!, company, 'POST',
    { bankAccountId, transactions: [{ transactionDate: '2026-09-03', description, debit: 77 }] },
    '/api/accounting/bank-transactions-import-classified');
  const linesNamed = async (description: string) =>
    (await pool.query('SELECT COUNT(*)::INT AS n FROM bank_transactions WHERE company_id = $1 AND description = $2',
      [f.c, description])).rows[0].n as number;

  // Everything this route writes is ONE atomic transaction([...]) and nothing is written before it, so a crash leaves
  // nothing by construction; what the catch-all got wrong here is the answer — a 400 for a fault. (The insert itself
  // cannot run on this schema: it names bank_transactions.suggested_cost_centre, which no migration creates. Reported.)
  it('a crash is a 500, not a 400, and no line or batch is left', async () => {
    faults.afterSql = /FROM bank_categorisation_rules/;
    const res = await importAs(f.c, f.bank, 'CATCHALL IMPORT');
    expect(faults.fired).toHaveLength(1);
    const batches = (await pool.query(
      "SELECT COUNT(*)::INT AS n FROM bank_import_batches WHERE company_id = $1 AND import_channel = 'classified'", [f.c])).rows[0].n;
    expect({ status: res.state.statusCode, lines: await linesNamed('CATCHALL IMPORT'), batches })
      .toEqual({ status: 500, lines: 0, batches: 0 });
  });

  it('another company\'s bank account is still refused 400', async () => {
    expect(refusalOf(await importAs(f.c, other.bank, 'CATCHALL FOREIGN')).status).toBe(400);
  });
});
