/**
 * Intercompany F: the receiver's state word (`intercompany_payment_message_state`, D2), the read-only list / detail and the suggestions. D2 answers
 * only the RECEIVER (session company = to_company_id, a signed-in member, kind payment); everyone else, P's own session and the third company
 * C included, gets the one `not_found`. Suggestions read R's own rows only, are never stored, and viewing writes nothing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { enableFxDocuments } from '../r035-approval.helpers';
import { asAppUser, count, plantMessage, withoutTrigger } from './intercompany.helpers';
import { mirrorCleanup, plantArInvoice, wipeConnections } from './mirror.helpers';
import { setLoanClearing } from './loan-clearing.helpers';
import { clearPayments, plantBill } from './allocation.helpers';
import {
  cashConnect, clearReceipts, co, connectBC, dataOf, party, payApi, paymentSetup, plantReceipt, rows, sentPayment, stateOf, U,
} from './payment.helpers';
import type { PaymentDetail, PaymentPage } from '../../../src/modules/accounting/services/intercompany/paymentInboxTypes';

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

const word = async (m: string, user = U.a, company = co.A) => (await stateOf(pool, m, user, company))[0];
const setConn = (set: string) => asAppUser(pool, U.ab, co.A, (q) => q.query(`UPDATE intercompany_connections SET ${set} WHERE id = $1`, [conn]), true);

describe('D2 state words, first wins', () => {
  it('open for a fresh message; live', async () => {
    const s = await sentPayment(pool, conn);
    expect(await word(s.message)).toEqual({ live: true, state: 'open' });
  });

  it('payer_gone after the payer voids the payment; link_gone after an unlink; connection_gone after a revoke', async () => {
    const one = await sentPayment(pool, conn);
    await pool.query("UPDATE supplier_payments SET status = 'cancelled' WHERE id = $1", [one.payment]);
    expect(await word(one.message)).toEqual({ live: false, state: 'payer_gone' });
    const two = await sentPayment(pool, conn);
    await withoutTrigger(pool, 'intercompany_document_links', 'trg_intercompany_links_guard', (q) => q.query("UPDATE intercompany_document_links SET status = 'unlinked' WHERE id = $1", [two.link]));
    expect((await word(two.message)).state).toBe('link_gone');
    await setConn("status = 'revoked'");
    expect((await word(two.message)).state).toBe('connection_gone');
  });

  it("not_enabled when the receiver's flag is off; future_dated; before_cutover; currency", async () => {
    const s = await sentPayment(pool, conn);
    await setLoanClearing(pool, [co.A], false);
    expect((await word(s.message)).state).toBe('not_enabled');
    await setLoanClearing(pool, [co.A], true);
    const future = await sentPayment(pool, conn, { date: '2099-01-01' });
    expect((await word(future.message)).state).toBe('future_dated');
    await setConn("cutover_date = DATE '2026-10-01'");
    expect((await word(s.message)).state).toBe('before_cutover');
    await setConn("cutover_date = DATE '2026-01-01'");
    await enableFxDocuments(pool, co.B);
    const usd = await sentPayment(pool, conn, {}, { currency: 'USD' });
    expect((await word(usd.message)).state).toBe('currency');
  });

  it('target_cancelled once R cancels the receipt an accepted message targets', async () => {
    const s = await sentPayment(pool, conn);
    const receipt = await plantReceipt(pool);
    const res = await payApi.accept(U.a, co.A, s.message, { outcome: 'existing', receiptId: receipt, expected: { amount: 1150, state: 'open' } });
    expect(res.state.statusCode).toBe(200);
    expect((await word(s.message)).state).toBe('target_ok');
    await pool.query("UPDATE customer_payments SET status = 'cancelled' WHERE id = $1", [receipt]);
    expect(await word(s.message)).toEqual({ live: false, state: 'target_cancelled' });
  });

  it('is no oracle: the payer, the third company, a non-member and another kind all get not_found', async () => {
    const s = await sentPayment(pool, conn);
    await connectBC(pool);
    expect((await word(s.message, U.b, co.B)).state).toBe('not_found');
    expect((await word(s.message, U.c, co.C)).state).toBe('not_found');
    expect((await word(s.message, U.x, co.A)).state).toBe('not_found');
    const reject = await plantMessage(pool, conn, co.B, co.A, { kind: 'reject', user: U.b });
    expect((await word(reject)).state).toBe('not_found');
    expect((await word(crypto.randomUUID())).state).toBe('not_found');
  });
});

describe('the list and the detail (read only)', () => {
  it('lists the payment for A with its state; C and B list nothing', async () => {
    const s = await sentPayment(pool, conn);
    await connectBC(pool);
    const page = dataOf<PaymentPage>(await payApi.list(U.a, co.A));
    expect(page.items.map((i) => i.id)).toEqual([s.message]);
    expect(page.items[0]).toMatchObject({ state: 'open', amount: 1150, issuerInvoice: { id: s.invoice } });
    expect(page.enabled).toBe(true);
    expect(dataOf<PaymentPage>(await payApi.list(U.c, co.C)).items).toHaveLength(0);
    expect(dataOf<PaymentPage>(await payApi.list(U.b, co.B)).items).toHaveLength(0);
    expect((await payApi.get(U.c, co.C, s.message)).state.statusCode).toBe(404);
  });

  it('the detail ranks the linked invoice first, offers other open invoices of the customer only, never pre-cut-over, closed or another customer\'s', async () => {
    const s = await sentPayment(pool, conn);
    const other = (await plantArInvoice(pool, { status: 'approved' })).id;
    const pre = (await plantArInvoice(pool, { status: 'approved', date: '2025-12-01' })).id;
    const closed = (await plantArInvoice(pool, { status: 'paid' })).id;
    const draft = (await plantArInvoice(pool, { status: 'draft' })).id;
    const stranger = crypto.randomUUID();
    await pool.query('INSERT INTO customers(id, company_id, name) VALUES ($1, $2, $3)', [stranger, co.A, 'IC stranger']);
    const foreign = (await plantArInvoice(pool, { status: 'approved', customer: stranger })).id;
    const d = dataOf<PaymentDetail>(await payApi.get(U.a, co.A, s.message));
    const ids = d.suggestions!.invoices.map((i) => i.id);
    expect(ids[0]).toBe(s.invoice);
    expect(d.suggestions!.invoices[0]!.linked).toBe(true);
    expect(ids).toContain(other);
    for (const x of [pre, closed, draft, foreign]) expect(ids).not.toContain(x);
  });

  it('the receipt candidates follow MED-2, and bank lines are a hint only', async () => {
    const s = await sentPayment(pool, conn);
    const exact = await plantReceipt(pool);                                                   // unallocated R1 150: a candidate
    const onLinked = await plantReceipt(pool, { amount: 2000, alloc: [{ invoice: s.invoice, amount: 1150 }] });
    const early = await plantReceipt(pool, { date: '2026-08-01' });                           // before the payment date
    const contra = await plantReceipt(pool, { method: 'contra' });
    const draft = await plantReceipt(pool, { status: 'draft' });
    const small = await plantReceipt(pool, { amount: 500 });
    const stranger = crypto.randomUUID();
    await pool.query('INSERT INTO customers(id, company_id, name) VALUES ($1, $2, $3)', [stranger, co.A, 'IC stranger 2']);
    const theirs = await plantReceipt(pool, { client: stranger });
    const elsewhere = await plantReceipt(pool, { alloc: [{ invoice: (await plantArInvoice(pool, { status: 'approved' })).id, amount: 1150 }] });
    const d = dataOf<PaymentDetail>(await payApi.get(U.a, co.A, s.message));
    const ids = d.suggestions!.receipts.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([exact, onLinked]));
    for (const x of [early, contra, draft, small, theirs, elsewhere]) expect(ids, x).not.toContain(x);
    expect(d.suggestions!.draftAllowed).toBe(false);                                          // an exact candidate exists (Q2)
    expect(d.suggestions!.bankLines.every((b) => !('accept' in b))).toBe(true);
  });

  it('viewing writes nothing (row counts and updated_at unchanged)', async () => {
    const s = await sentPayment(pool, conn);
    await plantReceipt(pool);
    const before = { msg: await rows.message(pool, s.message), receipts: await count(pool, 'SELECT count(*) AS n FROM customer_payments WHERE company_id = $1', [co.A]) };
    await payApi.list(U.a, co.A);
    await payApi.get(U.a, co.A, s.message);
    expect(await rows.message(pool, s.message)).toEqual(before.msg);
    expect(await count(pool, 'SELECT count(*) AS n FROM customer_payments WHERE company_id = $1', [co.A])).toBe(before.receipts);
  });

  it("the receiver's flag off: the list says enabled false and the detail offers no suggestions", async () => {
    const s = await sentPayment(pool, conn);
    await setLoanClearing(pool, [co.A], false);
    expect(dataOf<PaymentPage>(await payApi.list(U.a, co.A)).enabled).toBe(false);
    expect(dataOf<PaymentDetail>(await payApi.get(U.a, co.A, s.message)).suggestions).toBeNull();
  });

  it('an unlinked bill never reaches the receiver', async () => {
    await plantBill(pool, conn, { link: false });
    expect(dataOf<PaymentPage>(await payApi.list(U.a, co.A)).items).toHaveLength(0);
    expect(party.aCustomer).toBeTruthy();
  });
});
