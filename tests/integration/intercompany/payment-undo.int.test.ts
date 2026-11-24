/**
 * Intercompany F (k) H-1 / (l) MED-1: once the RECEIVER accepted a `payment` message, the PAYER cannot take its side back on its own: unapply,
 * void (the action route, MCP void_payment) and a reversal of the payment's journal are refused, nothing changed. While the message is pending
 * the void still works and the receiver then sees `payer_gone`. An unapply racing an accept takes the payment / journal / bill keys after its
 * payment row lock (the void's order) and is refused once the accept commits. The payment is a REAL one (approved and processed through the
 * routes), so the hook writes its message.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import journalActionRoute from '../../../pages/api/accounting/journal-entries-action';
import { voidPaymentTool } from '../../../src/lib/mcp/tools/writeVoidPayments';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { callRoute } from '../r035-approval.helpers';
import { payRoutes } from '../r035-pr5.helpers';
import { tokens } from './intercompany.helpers';
import { asService, mirrorCleanup, wipeConnections } from './mirror.helpers';
import { setLoanClearing } from './loan-clearing.helpers';
import { bank, clearPayments, plantBill } from './allocation.helpers';
import {
  blockedOn, cashConnect, clearReceipts, co, errorText, existingBody, openSession, party, payApi, paymentMessages, paymentSetup, plantReceipt, stateOf, U,
} from './payment.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const r = payRoutes(tokens);
let conn = '';
const CLEARED = /partner already (cleared|matched) this/i;

beforeAll(() => paymentSetup(pool), 60000);
afterAll(async () => { await clearReceipts(pool); await clearPayments(pool); await mirrorCleanup(pool); }, 60000);
beforeEach(async () => {
  await clearReceipts(pool);
  await clearPayments(pool);
  await wipeConnections(pool);
  await setLoanClearing(pool, [co.A, co.B, co.C], true);
  conn = await cashConnect(pool);
});

/** A real payment of B for its linked bill: drafted, approved and processed through the routes (the hook sends the payment message). */
async function realPaid() {
  const b = await plantBill(pool, conn);
  const id = (await pool.query(
    `INSERT INTO supplier_payments(company_id, supplier_id, payment_date, total_amount, payment_method, bank_account_id, reference, status, created_by)
     VALUES ($1, $2, DATE '2026-09-01', 1150, 'eft', $3, 'IC F ref', 'draft', $4) RETURNING id`, [co.B, party.bSupplier, bank.b, U.b])).rows[0].id as string;
  await pool.query('INSERT INTO payment_allocations(payment_id, invoice_id, amount_allocated) VALUES ($1, $2, 1150)', [id, b.bill]);
  for (const step of ['approve', 'process']) {
    const res = await r.payment(U.b, co.B, step, id);
    if (res.state.statusCode !== 200) throw new Error(`${step}: ${errorText(res)}`);
  }
  const [m] = await paymentMessages(pool);
  if (!m) throw new Error('the hook sent no payment message');
  const journal = String((await pool.query('SELECT gl_journal_entry_id FROM supplier_payments WHERE id = $1', [id])).rows[0].gl_journal_entry_id);
  return { ...b, payment: id, journal, message: String(m.id), amount: 1150 };
}
const action = (name: string, paymentId: string) => r.payment(U.b, co.B, name, paymentId);
const status = async (id: string) => String((await pool.query('SELECT status FROM supplier_payments WHERE id = $1', [id])).rows[0].status);
const reversals = async (je: string) => Number((await pool.query('SELECT count(*)::int AS n FROM gl_journal_entries WHERE reversal_of_id = $1', [je])).rows[0].n);

async function acceptedPaid() {
  const s = await realPaid();
  const receipt = await plantReceipt(pool);
  const res = await payApi.accept(U.a, co.A, s.message, existingBody(s, receipt));
  expect(res.state.statusCode, errorText(res)).toBe(200);
  return { ...s, receipt };
}

describe('after the receiver accepted', () => {
  it('unapply and void (the route) are refused with a plain sentence; nothing changed', async () => {
    const s = await acceptedPaid();
    for (const name of ['unapply', 'void']) {
      const res = await action(name, s.payment);
      expect(res.state.statusCode, name).toBe(400);
      expect(errorText(res), name).toMatch(CLEARED);
    }
    expect(await status(s.payment)).toBe('processed');
    expect(await reversals(s.journal)).toBe(0);
  });

  it('MCP void_payment and a reversal of the payment journal are refused too', async () => {
    const s = await acceptedPaid();
    const ctx = { companyId: co.B, userId: U.b, scopes: ['write:invoices', 'write:post'], companyRole: 'owner', tokenJti: null, oauthAppId: null };
    const err = await asService(pool, U.b, co.B, () => voidPaymentTool.handler({ payment_id: s.payment, idempotency_key: crypto.randomUUID() }, ctx as never))
      .then((x) => JSON.stringify(x), (e: unknown) => String(e));
    expect(err).toMatch(CLEARED);
    const rev = await callRoute(journalActionRoute, tokens[U.b]!, co.B, 'POST', { action: 'reverse', id: s.journal }, '/api/accounting/journal-entries-action');
    expect(rev.state.statusCode).toBeGreaterThanOrEqual(400);
    expect(rev.state.statusCode).toBeLessThan(500);
    expect(errorText(rev)).toMatch(CLEARED);
    expect(await reversals(s.journal)).toBe(0);
  });
});

describe('while the message is pending', () => {
  it('the void works and the receiver sees payer_gone (and cannot accept)', async () => {
    const s = await realPaid();
    const res = await action('void', s.payment);
    expect(res.state.statusCode, errorText(res)).toBe(200);
    expect((await stateOf(pool, s.message))[0]!.state).toBe('payer_gone');
    const receipt = await plantReceipt(pool);
    expect((await payApi.accept(U.a, co.A, s.message, existingBody(s, receipt))).state.statusCode).toBe(409);
  });

  it('an unapply racing an accept waits on the keys and is refused once the accept commits', async () => {
    const s = await realPaid();
    const receipt = await plantReceipt(pool);
    const accept = await openSession(pool, U.a, co.A);
    try {
      await accept.query('SELECT id FROM intercompany_messages WHERE id = $1 FOR UPDATE', [s.message]);
      await accept.query('SELECT public.intercompany_allocation_cap_lock($1)', [s.message]);
      const unapply = action('unapply', s.payment);
      await blockedOn(pool, 'pg_advisory_xact_lock', unapply);
      await accept.query("UPDATE intercompany_messages SET status = 'accepted', target_doc_type = 'customer_payment', target_doc_id = $2 WHERE id = $1", [s.message, receipt]);
      await accept.query('COMMIT');
      const res = await unapply;
      expect(res.state.statusCode).toBe(400);
      expect(errorText(res)).toMatch(CLEARED);
    } finally {
      accept.release();
    }
    expect(await status(s.payment)).toBe('processed');
  }, 30000);
});
