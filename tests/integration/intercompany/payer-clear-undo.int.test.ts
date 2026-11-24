/**
 * Intercompany P4-E (j).4 and (j).8: once the RECEIVER accepted the allocation message of the payer's clearing, the payer cannot undo it on its
 * own: unapply and void (the action route), MCP void_payment and a journal reversal of the clearing journal are refused with a plain sentence,
 * nothing changed. While the message is still pending, a void is allowed: it reverses the clearing journal once, reopens the bill, and the
 * message is no longer live (the receiver cannot accept it). While a connection carries an unhandled or accepted allocation message, unlinking a
 * pairing, changing the settlement mode and re-pointing either side's loan account are refused; a connection without one is unaffected.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import actionRoute from '../../../pages/api/accounting/supplier-payments-action';
import journalActionRoute from '../../../pages/api/accounting/journal-entries-action';
import { voidPaymentTool } from '../../../src/lib/mcp/tools/writeVoidPayments';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { callRoute } from '../r035-approval.helpers';
import { acct, api, asAppUser, co, tokens, U, wipeConnections } from './intercompany.helpers';
import { asService, mirrorCleanup } from './mirror.helpers';
import { clearPayments } from './allocation.helpers';
import { loan, outcomeOf } from './allocation-clear.helpers';
import { pairingApi } from './pairing.helpers';
import { clearBill, clearBody, clearConnect, clearedOf, errorText, payer, payerSetup, plantBill, receiverAccepts } from './payer-clear.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let conn = '';
const PARTNER_CLEARED = /partner already cleared this/i;
const HELD = /allocation message/i;

beforeAll(() => payerSetup(pool), 60000);
afterAll(async () => { await clearPayments(pool); await mirrorCleanup(pool); }, 60000);
beforeEach(async () => {
  await clearPayments(pool);
  await wipeConnections(pool);
  conn = await clearConnect(pool);
});

const action = (body: Record<string, unknown>) => callRoute(actionRoute, tokens[U.b]!, co.B, 'POST', body, '/api/accounting/supplier-payments-action');
const reversals = async (je: string) => Number((await pool.query('SELECT count(*)::int AS n FROM gl_journal_entries WHERE reversal_of_id = $1', [je])).rows[0].n);
const paymentStatus = async (id: string) => String((await pool.query('SELECT status FROM supplier_payments WHERE id = $1', [id])).rows[0].status);
const live = (message: string) => asAppUser(pool, U.a, co.A, async (q) => (await q.query('SELECT live, reason FROM public.intercompany_allocation_message_live($1)', [message])).rows[0] as { live: boolean; reason: string });

async function cleared() {
  const b = await plantBill(pool, conn);
  const res = await clearBill(clearBody(b));
  expect(res.state.statusCode, errorText(res)).toBe(200);
  return { b, out: clearedOf(res) };
}

async function accepted() {
  const c = await cleared();
  const acc = await receiverAccepts(c.out.messageId, c.b.invoice, 1150);
  expect(outcomeOf(acc), errorText(acc)).toMatchObject({ accepted: true });
  return c;
}

describe('the payer undo gate', () => {
  it('a pending message: the void reverses the clearing once, reopens the bill, and the message is no longer live', async () => {
    const { b, out } = await cleared();
    const res = await action({ action: 'void', paymentId: out.paymentId });
    expect(res.state.statusCode, errorText(res)).toBe(200);
    expect(await reversals(out.journalEntryId)).toBe(1);
    expect(await payer.open(pool, b.bill)).toBeCloseTo(1150, 2);
    expect(await paymentStatus(out.paymentId)).toBe('cancelled');
    expect(await live(out.messageId)).toMatchObject({ live: false });
    const acc = await receiverAccepts(out.messageId, b.invoice, 1150);
    expect(outcomeOf(acc)).toMatchObject({ accepted: false });
  });

  it('accepted by the receiver: unapply and void are refused with a plain sentence, nothing changed', async () => {
    const { b, out } = await accepted();
    for (const name of ['unapply', 'void']) {
      const res = await action({ action: name, paymentId: out.paymentId });
      expect(res.state.statusCode, name).toBe(400);
      expect(errorText(res)).toMatch(PARTNER_CLEARED);
    }
    expect(await reversals(out.journalEntryId)).toBe(0);
    expect(await payer.open(pool, b.bill)).toBeCloseTo(0, 2);
    expect(await paymentStatus(out.paymentId)).toBe('processed');
  });

  it('accepted: MCP void_payment and a journal reversal of the clearing journal are refused too', async () => {
    const { out } = await accepted();
    const ctx = { companyId: co.B, userId: U.b, scopes: ['write:invoices', 'write:post'], companyRole: 'owner', tokenJti: null, oauthAppId: null };
    const err = await asService(pool, U.b, co.B, () => voidPaymentTool.handler({ payment_id: out.paymentId, idempotency_key: crypto.randomUUID() }, ctx as never))
      .then((r) => JSON.stringify(r), (e: unknown) => String(e));
    expect(err).toMatch(PARTNER_CLEARED);
    const rev = await callRoute(journalActionRoute, tokens[U.b]!, co.B, 'POST', { action: 'reverse', id: out.journalEntryId }, '/api/accounting/journal-entries-action');
    expect(rev.state.statusCode).toBeGreaterThanOrEqual(400);
    expect(rev.state.statusCode).toBeLessThan(500);
    expect(errorText(rev)).toMatch(PARTNER_CLEARED);
    expect(await reversals(out.journalEntryId)).toBe(0);
    expect(await paymentStatus(out.paymentId)).toBe('processed');
  });
});

describe('the connection while an allocation message is open or accepted', () => {
  it('pending: unlinking the pairing, the settlement mode and either loan account are refused (409)', async () => {
    const { b } = await cleared();
    const unlink = await pairingApi.unlink(U.b, co.B, conn, b.link!);
    expect(unlink.state.statusCode).toBe(409);
    expect(errorText(unlink)).toMatch(HELD);
    const mode = await api.settings(U.ab, co.A, conn, { settlementMode: 'cash' });
    expect(mode.state.statusCode).toBe(409);
    expect(errorText(mode)).toMatch(HELD);
    const other = crypto.randomUUID();
    await pool.query(
      `INSERT INTO gl_accounts(id, company_id, account_code, account_name, account_type, normal_balance, is_active, account_subtype)
       VALUES ($1, $2, $3, 'IC B loan 2', 'liability', 'credit', true, 'other_current_liability')`, [other, co.B, `IL2${other.slice(0, 5)}`]);
    const payerSide = await api.edit(U.b, co.B, conn, { loanAccountId: other });
    expect(payerSide.state.statusCode).toBe(409);
    expect(errorText(payerSide)).toMatch(HELD);
    const receiverSide = await api.edit(U.a, co.A, conn, { loanAccountId: loan.a2 });
    expect(receiverSide.state.statusCode).toBe(409);
    expect((await pool.query("SELECT status FROM intercompany_document_links WHERE id = $1", [b.link])).rows[0].status).toBe('active');
    expect((await pool.query('SELECT settlement_mode FROM intercompany_connections WHERE id = $1', [conn])).rows[0].settlement_mode).toBe('loan');
    expect((await pool.query('SELECT loan_account_id FROM intercompany_connection_sides WHERE connection_id = $1 AND company_id = $2', [conn, co.B])).rows[0].loan_account_id).toBe(acct.bLoan);
  });

  it('accepted: the same changes are refused', async () => {
    const { b } = await accepted();
    expect((await pairingApi.unlink(U.b, co.B, conn, b.link!)).state.statusCode).toBe(409);
    expect((await api.settings(U.ab, co.A, conn, { settlementMode: 'cash' })).state.statusCode).toBe(409);
    expect((await api.edit(U.a, co.A, conn, { loanAccountId: loan.a2 })).state.statusCode).toBe(409);
  });

  it('no allocation message on the connection: the changes go through as before', async () => {
    const b = await plantBill(pool, conn);
    expect((await api.edit(U.a, co.A, conn, { loanAccountId: loan.a2 })).state.statusCode).toBe(200);
    expect((await pairingApi.unlink(U.b, co.B, conn, b.link!)).state.statusCode).toBe(200);
    expect((await api.settings(U.ab, co.A, conn, { settlementMode: 'cash' })).state.statusCode).toBe(200);
  });
});
