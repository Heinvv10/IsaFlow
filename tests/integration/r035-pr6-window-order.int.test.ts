/**
 * R-035 PR6 x #659 (the ledger-date window): a gated path that CREATES its journal answers the manual-journal
 * approval BEFORE the window, the order #659 set for payments (numrace-payment-gate-order). Dated 2205-01-01,
 * outside 1900..2199, and refused by a rule -> 409 APPROVAL_REQUIRED; with enforcement off the same request is
 * refused 400 at the window. Nothing is written either way.
 *
 *  - Allocating a hand-keyed bank line to an account (bank-transactions-action), the line dated 2205.
 *  - The bank-reconciliation adjustment (H1), the statement dated 2205.
 *
 * The UI post and close-run's `post_draft_journal` post a draft that exists, whose date the window checked when
 * it was created (journalEntryCrudService), so no window answers on those paths at all.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import bankTransactionsAction from '../../pages/api/accounting/bank-transactions-action';
import bankReconciliationsAction from '../../pages/api/accounting/bank-reconciliations-action';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, plantRule, reasonOf } from './r035-approval.helpers';
import { cleanupPr6, enforceJournals, journalCompany, journalRule, type JournalCompany } from './r035-pr6.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let a = '';
const OUT_OF_WINDOW = '2205-01-01';

beforeAll(async () => { a = await createUser(pool, tokens); });
afterAll(async () => {
  await pool.query('DELETE FROM bank_reconciliations WHERE company_id = ANY($1)', [companies]);
  await cleanupPr6(pool, companies, [a]);
});

async function fixture(enforced: boolean): Promise<JournalCompany> {
  const f = await journalCompany(pool, [[a, 'admin']], companies);
  await journalRule(plantRule, pool, f.c);
  if (enforced) await enforceJournals(pool, f.c, a);
  return f;
}
const call = (handler: unknown, c: string, body: unknown, url: string) => callRoute(handler as never, tokens[a]!, c, 'POST', body, url);
const journals = async (c: string) => Number((await pool.query(
  'SELECT count(*)::INT AS n FROM gl_journal_entries WHERE company_id = $1', [c])).rows[0].n);
const refusedForApproval = (res: { state: { statusCode: number; body: unknown } }) => {
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
  expect(reasonOf(res)).toBe('APPROVAL_REQUIRED');
};
const refusedAtTheWindow = (res: { state: { statusCode: number; body: unknown } }) => {
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
  expect(JSON.stringify(res.state.body)).toMatch(/outside 1900-01-01 to 2199-12-31/);
};

describe('allocate a hand-keyed line to an account: approval before the window', () => {
  const allocate = async (f: JournalCompany) => {
    const { rows: [line] } = await pool.query(
      `INSERT INTO bank_transactions(company_id, bank_account_id, transaction_date, amount, description, status)
       VALUES($1,$2,$3::DATE,-1500,'R035 window','imported') RETURNING id`, [f.c, f.bank, OUT_OF_WINDOW]);
    const res = await call(bankTransactionsAction, f.c, { action: 'allocate', bankTransactionId: line.id,
      allocationType: 'account', contraAccountId: f.expA }, '/api/accounting/bank-transactions-action');
    const { rows: [after] } = await pool.query('SELECT status FROM bank_transactions WHERE id = $1', [line.id]);
    return { res, status: after.status as string };
  };

  it('refused by a rule -> 409 APPROVAL_REQUIRED, nothing written', async () => {
    const f = await fixture(true);
    const { res, status } = await allocate(f);
    refusedForApproval(res);
    expect(status).toBe('imported');
    expect(await journals(f.c)).toBe(0);
  });

  it('enforcement off -> 400 at the window, nothing written', async () => {
    const f = await fixture(false);
    const { res, status } = await allocate(f);
    refusedAtTheWindow(res);
    expect(status).toBe('imported');
    expect(await journals(f.c)).toBe(0);
  });
});

describe('the bank-reconciliation adjustment: approval before the window', () => {
  const adjust = async (f: JournalCompany) => {
    const { rows: [rec] } = await pool.query(
      `INSERT INTO bank_reconciliations(company_id, bank_account_id, statement_date, started_by) VALUES($1,$2,$3::DATE,$4) RETURNING id`,
      [f.c, f.bank, OUT_OF_WINDOW, a]);
    return call(bankReconciliationsAction, f.c, { action: 'adjustment', reconciliationId: rec.id, bankAccountId: f.bank,
      contraAccountId: f.expA, amount: 1500, description: 'R035 window' }, '/api/accounting/bank-reconciliations-action');
  };

  it('refused by a rule -> 409 APPROVAL_REQUIRED, nothing written', async () => {
    const f = await fixture(true);
    refusedForApproval(await adjust(f));
    expect(await journals(f.c)).toBe(0);
  });

  it('enforcement off -> 400 at the window, nothing written', async () => {
    const f = await fixture(false);
    refusedAtTheWindow(await adjust(f));
    expect(await journals(f.c)).toBe(0);
  });
});
