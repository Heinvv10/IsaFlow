/**
 * Intercompany F, review round 1: the orphan F draft, and who may reject / dismiss / restore a payment message.
 *   LOW-3  a non-contra draft stamped IC:<id> where no payment message of this company has that id is REFUSED at confirm (never fails open)
 *          and has a way out: the discard (D4) cancels it alone (reason 'orphan', one audit row); the receipt chip names it.
 *   LOW-4  reject (final) needs the receiver's dark flag; dismiss and restore (reversible, the message only) stay allowed with it off.
 *   AUTH   reject needs Approve on Customers & AR (handleService.rejectPayment -> mayApprove): a write-role user without it is 403, nothing
 *          written; the owner rejects.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { asAppUser, count } from './intercompany.helpers';
import { mirrorCleanup, plantArInvoice, wipeConnections } from './mirror.helpers';
import { setLoanClearing } from './loan-clearing.helpers';
import { clearPayments } from './allocation.helpers';
import { cashConnect, clearReceipts, co, dataOf, errorText, payApi, paymentSetup, plantReceipt, rows, sentPayment, U } from './payment.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let conn = '';

beforeAll(() => paymentSetup(pool), 60000);
afterAll(async () => { await clearReceipts(pool); await clearPayments(pool); await mirrorCleanup(pool); }, 60000);
beforeEach(async () => {
  await clearReceipts(pool);
  await clearPayments(pool);
  await wipeConnections(pool);
  await setLoanClearing(pool, [co.A, co.B, co.C], true);
  conn = await cashConnect(pool);
});

const receiptStatus = async (id: string) => String((await pool.query('SELECT status FROM customer_payments WHERE id = $1', [id])).rows[0].status);
async function orphan(stamp = crypto.randomUUID()) {
  const invoice = (await plantArInvoice(pool, { status: 'approved' })).id;
  const draft = await plantReceipt(pool, { status: 'draft', amount: 1150, bankReference: `IC:${stamp}`, createdBy: U.a, alloc: [{ invoice, amount: 1150 }] });
  return { stamp, draft, invoice };
}

describe('LOW-3: the orphan F draft', () => {
  it('confirm is refused, nothing posted (no payment message of this company has the stamped id)', async () => {
    const o = await orphan();
    const before = await rows.journals(pool, co.A);
    const res = await payApi.confirmReceipt(U.a, co.A, o.draft);
    expect(res.state.statusCode, errorText(res)).toBeGreaterThanOrEqual(400);
    expect(res.state.statusCode).toBeLessThan(500);
    expect(errorText(res)).toMatch(/drafted from an intercompany payment message/);
    expect(await receiptStatus(o.draft)).toBe('draft');
    expect(await rows.journals(pool, co.A)).toBe(before);
  });

  it("a stamp naming ANOTHER company's message is an orphan here too", async () => {
    const s = await sentPayment(pool, conn);                                             // B -> A; B's own view of it is not B's to receive
    const res = await payApi.confirmReceipt(U.b, co.B, (await pool.query(
      `INSERT INTO customer_payments(company_id, client_id, payment_date, total_amount, payment_method, bank_reference, status, created_by)
       VALUES ($1, (SELECT id FROM customers WHERE company_id = $1 LIMIT 1), DATE '2026-09-02', 10, 'eft', $2, 'draft', $3) RETURNING id`,
      [co.B, `IC:${s.message}`, U.b])).rows[0].id as string);
    expect(res.state.statusCode, errorText(res)).toBeGreaterThanOrEqual(400);
    expect(errorText(res)).toMatch(/drafted from an intercompany payment message/);
  });

  it('the discard cancels it alone: draft cancelled, one audit row, no message touched; the chip names it', async () => {
    const o = await orphan();
    expect(dataOf(await payApi.receiptState(U.a, co.A, o.draft))).toMatchObject({ messageId: o.stamp, status: 'orphan', state: 'not_found' });
    const messages = await count(pool, 'SELECT count(*) AS n FROM intercompany_messages');
    const res = await payApi.discard(U.a, co.A, o.stamp, { paymentId: o.draft, reason: 'its message is gone' });
    expect(res.state.statusCode, errorText(res)).toBe(200);
    expect(await receiptStatus(o.draft)).toBe('cancelled');
    expect(await count(pool, 'SELECT count(*) AS n FROM intercompany_messages')).toBe(messages);
    expect(await count(pool, `SELECT count(*) AS n FROM audit_log WHERE company_id = $1 AND entity_id = $2 AND entity_type = 'customer_payment'
                               AND changes -> 'metadata' ->> 'event' = 'ic_payment_draft_discarded' AND changes -> 'metadata' ->> 'orphan' = 'true'`, [co.A, o.draft])).toBe(1);
  });

  it('D4 orphan path refuses what is not an orphan F draft: a plain draft, a contra, a confirmed one, a user without Approve', async () => {
    const plain = await plantReceipt(pool, { status: 'draft' });
    expect((await payApi.discard(U.a, co.A, crypto.randomUUID(), { paymentId: plain, reason: 'x' })).state.statusCode).toBe(404);
    const stamp = crypto.randomUUID();
    const contra = await plantReceipt(pool, { status: 'draft', method: 'contra', bankReference: `IC:${stamp}` });
    expect((await payApi.discard(U.a, co.A, stamp, { paymentId: contra, reason: 'x' })).state.statusCode).toBe(404);
    const done = await plantReceipt(pool, { bankReference: `IC:${stamp}` });
    expect((await payApi.discard(U.a, co.A, stamp, { paymentId: done, reason: 'x' })).state.statusCode).toBe(409);
    const o = await orphan();
    expect((await payApi.discard(U.mab, co.A, o.stamp, { paymentId: o.draft, reason: 'x' })).state.statusCode).toBe(403);
    const r = await asAppUser(pool, U.va, co.A, async (q) => (await q.query('SELECT ok, reason FROM public.intercompany_discard_payment_draft($1, $2, $3)', [o.stamp, o.draft, 'x'])).rows[0]);
    expect(r).toEqual({ ok: false, reason: 'forbidden' });
    for (const id of [plain, contra, o.draft]) expect(await receiptStatus(id)).toBe('draft');
    expect(await receiptStatus(done)).toBe('confirmed');
  });
});

describe('LOW-4 and AUTH: reject / dismiss / restore of a payment message', () => {
  it('reject needs Approve on Customers & AR: a write-role manager without it is 403 and nothing changes; the owner rejects', async () => {
    const s = await sentPayment(pool, conn);
    const before = await rows.message(pool, s.message);
    const res = await payApi.reject(U.mab, co.A, s.message, { reason: 'not ours' });
    expect(res.state.statusCode, errorText(res)).toBe(403);
    expect(errorText(res)).toMatch(/Approve on Customers & AR/);
    expect(await rows.message(pool, s.message)).toEqual(before);
    expect((await payApi.reject(U.a, co.A, s.message, { reason: 'not ours' })).state.statusCode).toBe(200);
    expect((await rows.message(pool, s.message)).status).toBe('rejected');
  });

  it("reject is refused 403 with the receiver's flag off (final); dismiss and restore stay allowed (reversible, the message only)", async () => {
    const s = await sentPayment(pool, conn);
    await setLoanClearing(pool, [co.A], false);
    const before = await rows.message(pool, s.message);
    const res = await payApi.reject(U.a, co.A, s.message, { reason: 'not ours' });
    expect(res.state.statusCode, errorText(res)).toBe(403);
    expect(errorText(res)).toMatch(/not enabled/);
    expect(await rows.message(pool, s.message)).toEqual(before);
    expect((await payApi.dismiss(U.a, co.A, s.message)).state.statusCode).toBe(200);
    expect((await payApi.restore(U.a, co.A, s.message)).state.statusCode).toBe(200);
    expect((await rows.message(pool, s.message)).status).toBe('pending');
  });

  it('dismiss and restore need the write role: a viewer is 403', async () => {
    const s = await sentPayment(pool, conn);
    expect((await payApi.dismiss(U.va, co.A, s.message)).state.statusCode).toBe(403);
    expect((await rows.message(pool, s.message)).status).toBe('pending');
  });
});
