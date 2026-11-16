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
  await pool.query('DELETE FROM cost_centres WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM business_units WHERE company_id = ANY($1)', [companies]);
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

  it('the typed refusals keep their 4xx: a missing line is 404, reversing a line with nothing to reverse is 400', async () => {
    const missing = crypto.randomUUID();
    expect(refusalOf(await act(a, f.c, { action: 'exclude', bankTransactionId: missing })).status).toBe(404);
    const line = await plantLine(pool, f, null, -100);
    const reverse = refusalOf(await act(a, f.c, { action: 'reverse', bankTransactionId: line }));
    expect(reverse).toMatchObject({ status: 400, message: expect.stringMatching(/Can only reverse allocated, matched, or reconciled/) });
    expect((await pool.query('SELECT status FROM bank_transactions WHERE id = $1', [line])).rows[0].status).toBe('imported');
  });
});

describe('bank-transactions-import-classified: it imports, and a crash after the insert is a 500 that rolls back', () => {
  const importAs = (company: string, bankAccountId: string, transactions: Record<string, unknown>[]) => callRoute(
    importClassified as never, tokens[a]!, company, 'POST', { bankAccountId, transactions },
    '/api/accounting/bank-transactions-import-classified');
  const linesNamed = async (prefix: string) => (await pool.query(
    `SELECT description, amount::FLOAT8 AS amount, cc1_id::TEXT AS cc1, cc2_id::TEXT AS cc2, bu_id::TEXT AS bu
     FROM bank_transactions WHERE company_id = $1 AND description LIKE $2 ORDER BY description`, [f.c, `${prefix}%`])).rows;
  const batches = async () => (await pool.query(
    "SELECT COUNT(*)::INT AS n FROM bank_import_batches WHERE company_id = $1 AND import_channel = 'classified'", [f.c])).rows[0].n as number;

  // It inserted nothing on any schema: it named bank_transactions.suggested_cost_centre, which no migration creates.
  // The worksheet's cost centres now land in the line's own dimension columns, resolved by code or name.
  it('a worksheet of two lines inserts two lines, their cost centres resolved to the line\'s dimensions', async () => {
    const cc1 = (await pool.query(
      "INSERT INTO cost_centres(company_id, code, name, cc_type) VALUES($1,'FNO-CA','Fibre Cape','cc1') RETURNING id", [f.c])).rows[0].id;
    const bu = (await pool.query(
      "INSERT INTO business_units(company_id, code, name) VALUES($1,'BU-CA','Cape Ops') RETURNING id", [f.c])).rows[0].id;
    const before = await batches();
    const res = await importAs(f.c, f.bank, [
      { transactionDate: '2026-09-04', description: 'WS LINE A', debit: 40, costCentreT1: 'fno-ca', businessUnit: 'Cape Ops' },
      { transactionDate: '2026-09-05', description: 'WS LINE B', credit: 15, costCentreT2: 'Nowhere' },
    ]);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(201);
    expect((res.state.body as { data: Record<string, unknown> }).data)
      .toMatchObject({ inserted: 2, skippedDuplicates: 0, unresolvedDimensions: ['T2: Nowhere'] });
    expect(await linesNamed('WS LINE')).toEqual([
      { description: 'WS LINE A', amount: -40, cc1, cc2: null, bu },
      { description: 'WS LINE B', amount: 15, cc1: null, cc2: null, bu: null },
    ]);
    expect(await batches()).toBe(before + 1);
  });

  it('the lines were inserted, then a TypeError — 500, and no line or batch is left', async () => {
    const before = await batches();
    faults.afterLog = 'Imported classified bank transactions';
    const res = await importAs(f.c, f.bank, [{ transactionDate: '2026-09-06', description: 'WS CRASH', debit: 77 }]);
    expect(faults.fired).toHaveLength(1);
    expect({ status: res.state.statusCode, lines: await linesNamed('WS CRASH'), batches: await batches() })
      .toEqual({ status: 500, lines: [], batches: before });
  });

  it('another company\'s bank account is still refused 400', async () => {
    expect(refusalOf(await importAs(f.c, other.bank,
      [{ transactionDate: '2026-09-03', description: 'WS FOREIGN', debit: 1 }])).status).toBe(400);
  });
});
