/**
 * Intercompany P4-D: who may clear, and what is approved is what posts. A viewer, a manager without Approve on Customers & AR and a Login-as
 * session are refused BEFORE anything is read or written (403; the message stays pending, not failed). Another tenant, the payer itself and a
 * member of both acting as a third company get the one answer, 404; no session is a 401. A stale preview (the loan account changed, another
 * invoice or amount) is a 409 and a bad posting date (before the payment, after today, not a date) a 400, nothing written. The preview on the
 * detail names both legs, the amount, the invoice and proposes the payment date, or the first open date after it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { impersonationToken } from '../r035-pr2.helpers';
import { acct, asAppUser, co, U, wipeConnections } from './intercompany.helpers';
import { mirrorCleanup } from './mirror.helpers';
import { clearPayments } from './allocation.helpers';
import { accept, acceptAs, bodyFor, clearConnect, clearSetup, ledger, loan, outcomeOf, previewFor, sentClearable } from './allocation-clear.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let conn = '';

beforeAll(() => clearSetup(pool), 60000);
afterAll(async () => { await clearPayments(pool); await mirrorCleanup(pool); }, 60000);
beforeEach(async () => {
  await clearPayments(pool);
  await wipeConnections(pool);
  conn = await clearConnect(pool);
});

type Sent = Awaited<ReturnType<typeof sentClearable>>;

/** The call answered `status` and left everything as it was: the message pending, no journal, no receipt. */
async function untouched(sent: Sent, call: () => ReturnType<typeof accept>, status: number) {
  const [journals, receipts] = [await ledger.journals(pool), await ledger.receipts(pool)];
  const res = await call();
  expect(res.state.statusCode).toBe(status);
  expect(await ledger.message(pool, sent.message)).toMatchObject({ status: 'pending', error: null, target_doc_id: null });
  expect([await ledger.journals(pool), await ledger.receipts(pool)]).toEqual([journals, receipts]);
  return res;
}

describe('who may clear', () => {
  it('a viewer, a manager without Approve on Customers & AR, a Login-as session: refused before anything', async () => {
    const sent = await sentClearable(pool, conn);
    await untouched(sent, () => acceptAs(U.va, co.A, sent.message, bodyFor(sent)), 403);
    await untouched(sent, () => acceptAs(U.mab, co.A, sent.message, bodyFor(sent)), 403);
    const res = await untouched(sent, async () => acceptAs(U.a, co.A, sent.message, bodyFor(sent), await impersonationToken(pool, U.a, U.ab)), 403);
    expect(JSON.stringify(res.state.body)).toMatch(/IMPERSONATION_FORBIDDEN/);
  });

  it('another tenant, the payer, a member of both acting as a third company: 404; no session: 401', async () => {
    const sent = await sentClearable(pool, conn);
    await untouched(sent, () => acceptAs(U.c, co.C, sent.message, bodyFor(sent)), 404);
    await untouched(sent, () => acceptAs(U.b, co.B, sent.message, bodyFor(sent)), 404);
    await untouched(sent, () => acceptAs(U.ac, co.C, sent.message, bodyFor(sent)), 404);
    await untouched(sent, () => acceptAs(U.a, co.A, sent.message, bodyFor(sent), ''), 401);
  });
});

describe('what is approved is what posts', () => {
  it('the loan account changed after the preview: 409, nothing posted, and the new preview names the new account', async () => {
    const sent = await sentClearable(pool, conn);
    expect((await previewFor(sent.message)).preview).toMatchObject({ loanAccountId: acct.aLoan });
    await asAppUser(pool, U.a, co.A, (q) => q.query('UPDATE intercompany_connection_sides SET loan_account_id = $3 WHERE connection_id = $1 AND company_id = $2', [conn, co.A, loan.a2]), true);
    await untouched(sent, () => accept(sent.message, bodyFor(sent)), 409);
    expect((await previewFor(sent.message)).preview).toMatchObject({ loanAccountId: loan.a2 });
    expect(outcomeOf(await accept(sent.message, bodyFor(sent, { expectedLoanAccountId: loan.a2 })))).toMatchObject({ accepted: true });
    expect(await ledger.balance(pool, loan.a2)).toBeCloseTo(1150, 2);
  });

  it('another invoice or another amount than the message: 409', async () => {
    const sent = await sentClearable(pool, conn);
    const other = await sentClearable(pool, conn);
    await untouched(sent, () => accept(sent.message, bodyFor(sent, { invoiceId: other.invoice })), 409);
    await untouched(sent, () => accept(sent.message, bodyFor(sent, { amount: 1000 })), 409);
  });

  it('a posting date before the payment, after today, or not a date; a body that is not the preview: 400', async () => {
    const sent = await sentClearable(pool, conn);
    await untouched(sent, () => accept(sent.message, bodyFor(sent, { postingDate: '2026-08-31' })), 400);
    await untouched(sent, () => accept(sent.message, bodyFor(sent, { postingDate: '2099-01-01' })), 400);
    await untouched(sent, () => accept(sent.message, bodyFor(sent, { postingDate: '2026-02-30' })), 400);
    await untouched(sent, () => accept(sent.message, { invoiceId: sent.invoice, amount: 1150, postingDate: '2026-09-01' }), 400);
    await untouched(sent, () => accept(sent.message, bodyFor(sent, { amount: 11.505 })), 400);
  });
});

describe('the preview', () => {
  it('names the loan account (debit) and Accounts Receivable (credit), the amount and the invoice, and proposes the payment date', async () => {
    const sent = await sentClearable(pool, conn);
    const number = (await pool.query('SELECT invoice_number FROM customer_invoices WHERE id = $1', [sent.invoice])).rows[0].invoice_number;
    const loanCode = (await pool.query('SELECT account_code FROM gl_accounts WHERE id = $1', [acct.aLoan])).rows[0].account_code;
    const p = (await previewFor(sent.message)).preview;
    expect(p).toMatchObject({ loanAccountId: acct.aLoan, amount: 1150, invoiceId: sent.invoice, invoiceNumber: number, paymentDate: '2026-09-01', defaultPostingDate: '2026-09-01' });
    expect(p?.loanAccountLabel).toBe(`${loanCode} ${loanCode}`);
    expect(p?.receivableLabel).toMatch(/IC receivable$/);
  });

  it('is null once the message is handled', async () => {
    const sent = await sentClearable(pool, conn);
    expect(outcomeOf(await accept(sent.message, bodyFor(sent)))).toMatchObject({ accepted: true });
    expect((await previewFor(sent.message)).preview).toBeNull();
  });

  it("proposes the first open date after the payment when the payment's period is closed", async () => {
    const sent = await sentClearable(pool, conn);
    const extra = crypto.randomUUID();
    await pool.query("UPDATE fiscal_periods SET end_date = '2026-09-15' WHERE company_id = $1", [co.A]);
    await pool.query(
      `INSERT INTO fiscal_periods(id, company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
       VALUES ($1, $2, 'IC 2026 b', 2, 2026, '2026-09-16', '2026-12-31', 'open')`, [extra, co.A]);
    await pool.query("UPDATE fiscal_periods SET status = 'closed' WHERE company_id = $1 AND id <> $2", [co.A, extra]);
    try {
      expect((await previewFor(sent.message)).preview).toMatchObject({ paymentDate: '2026-09-01', defaultPostingDate: '2026-09-16' });
    } finally {
      await pool.query("UPDATE fiscal_periods SET status = 'open' WHERE company_id = $1", [co.A]);
      await pool.query('DELETE FROM fiscal_periods WHERE id = $1', [extra]);
      await pool.query("UPDATE fiscal_periods SET end_date = '2026-12-31' WHERE company_id = $1", [co.A]);
    }
  });
});
