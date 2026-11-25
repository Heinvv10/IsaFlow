/**
 * Intercompany P4-E (j).5, migration 1029: `intercompany_receiver_loan_ready(link, bill, amount)` asked DIRECTLY as app_user (as withAuth opens a
 * request). It answers only the PAYER, a signed-in member of the session company with an intercompany write role, for ITS bill in an ACTIVE link
 * to the partner's customer invoice: anyone else, any other link or bill, a NULL or non-positive amount, is the one word `not_found`. Every
 * other word it can answer is reached here from the partner's rows (fix round 1, M). The words are pinned against the code's list in
 * tests/unit/services/intercompany/payerLoanClearRefusals.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { acct, asAppUser, co, party, U, wipeConnections } from './intercompany.helpers';
import { mirrorCleanup } from './mirror.helpers';
import { clearPayments } from './allocation.helpers';
import { setLoanClearing } from './loan-clearing.helpers';
import { clearConnect, payerSetup, plantBill } from './payer-clear.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let conn = '';
let b: Awaited<ReturnType<typeof plantBill>>;

beforeAll(() => payerSetup(pool), 60000);
afterAll(async () => { await clearPayments(pool); await mirrorCleanup(pool); }, 60000);
beforeEach(async () => {
  await clearPayments(pool);
  await wipeConnections(pool);
  conn = await clearConnect(pool);
  b = await plantBill(pool, conn);
});

const ready = (over: { user?: string; company?: string; link?: string | null; bill?: string | null; amount?: number | null } = {}) =>
  asAppUser(pool, over.user ?? U.b, over.company ?? co.B, async (q) => (await q.query(
    'SELECT public.intercompany_receiver_loan_ready($1::uuid, $2::uuid, $3::numeric) AS r',
    [over.link === undefined ? b.link : over.link, over.bill === undefined ? b.bill : over.bill, over.amount === undefined ? 1150 : over.amount])).rows[0].r as string);

/** `change` on the partner's rows (as the table owner), the word asked, then `undo`. */
async function wordWhile(change: string, undo: string, params: unknown[]): Promise<string> {
  await pool.query(change, params);
  try {
    return await ready();
  } finally {
    await pool.query(undo, params);
  }
}

describe('who may ask, and about what', () => {
  it('the payer, a writer, for its own linked bill: ready', async () => {
    expect(await ready()).toBe('ready');
  });

  it('a non-member, a viewer of the payer, the partner itself, a third company: not_found', async () => {
    expect(await ready({ user: U.x })).toBe('not_found');
    expect(await ready({ user: U.avb })).toBe('not_found');
    expect(await ready({ user: U.a, company: co.A })).toBe('not_found');
    expect(await ready({ user: U.c, company: co.C })).toBe('not_found');
  });

  it("another link, another bill, the partner's invoice as the bill, a NULL or non-positive amount: not_found", async () => {
    const other = await plantBill(pool, conn);
    expect(await ready({ link: other.link })).toBe('not_found');
    expect(await ready({ bill: other.bill })).toBe('not_found');
    expect(await ready({ bill: b.invoice })).toBe('not_found');
    expect(await ready({ link: crypto.randomUUID() })).toBe('not_found');
    expect(await ready({ amount: 0 })).toBe('not_found');
    expect(await ready({ amount: -5 })).toBe('not_found');
    expect(await ready({ amount: null })).toBe('not_found');
    expect(await ready({ link: null })).toBe('not_found');
  });
});

describe('every word from the partner rows', () => {
  it('receiver_flag_off', async () => {
    await setLoanClearing(pool, [co.A], false);
    try {
      expect(await ready()).toBe('receiver_flag_off');
    } finally {
      await setLoanClearing(pool, [co.A], true);
    }
  });

  it('receiver_loan_not_set_up and loan_class_mismatch', async () => {
    expect(await wordWhile('UPDATE gl_accounts SET is_active = false WHERE id = $1', 'UPDATE gl_accounts SET is_active = true WHERE id = $1', [acct.aLoan]))
      .toBe('receiver_loan_not_set_up');
    expect(await wordWhile(
      "UPDATE gl_accounts SET account_type = 'liability', normal_balance = 'credit', account_subtype = 'other_current_liability' WHERE id = $1",
      "UPDATE gl_accounts SET account_type = 'asset', normal_balance = 'debit', account_subtype = 'other_current_asset' WHERE id = $1", [acct.aLoan]))
      .toBe('loan_class_mismatch');
  });

  it('invoice_gone, invoice_not_open, currency, wrong_customer, invoice_pre_cutover, exceeds_open', async () => {
    const inv = [b.invoice];
    expect(await wordWhile('UPDATE customer_invoices SET deleted_at = now() WHERE id = $1', 'UPDATE customer_invoices SET deleted_at = NULL WHERE id = $1', inv)).toBe('invoice_gone');
    expect(await wordWhile("UPDATE customer_invoices SET status = 'paid' WHERE id = $1", "UPDATE customer_invoices SET status = 'approved' WHERE id = $1", inv)).toBe('invoice_not_open');
    await pool.query('UPDATE companies SET fx_documents_enabled = true WHERE id = $1', [co.A]);
    try {
      expect(await wordWhile("UPDATE customer_invoices SET currency_code = 'USD' WHERE id = $1", "UPDATE customer_invoices SET currency_code = 'ZAR' WHERE id = $1", inv)).toBe('currency');
    } finally {
      await pool.query('UPDATE companies SET fx_documents_enabled = false WHERE id = $1', [co.A]);
    }
    const other = crypto.randomUUID();
    await pool.query("INSERT INTO customers(id, company_id, name) VALUES ($1, $2, 'IC A readiness other')", [other, co.A]);
    await pool.query('UPDATE customer_invoices SET customer_id = $2, client_id = $2 WHERE id = $1', [b.invoice, other]);
    expect(await ready()).toBe('wrong_customer');
    await pool.query('UPDATE customer_invoices SET customer_id = $2, client_id = $2 WHERE id = $1', [b.invoice, party.aCustomer]);
    expect(await wordWhile("UPDATE customer_invoices SET invoice_date = DATE '2025-12-01' WHERE id = $1",
      "UPDATE customer_invoices SET invoice_date = DATE '2026-09-01' WHERE id = $1", inv)).toBe('invoice_pre_cutover');
    expect(await wordWhile('UPDATE customer_invoices SET amount_paid = 0.01 WHERE id = $1', 'UPDATE customer_invoices SET amount_paid = 0 WHERE id = $1', inv)).toBe('exceeds_open');
    expect(await ready()).toBe('ready');
  });
});
