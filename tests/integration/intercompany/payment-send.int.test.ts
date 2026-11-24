/**
 * Intercompany F: the PAYER's `payment` message (migration 1031, `intercompany_send_for_payment`, D1). When the payer's posted cash (a journal
 * that does NOT credit its loan account) is applied to a bill that is in an ACTIVE link with the issuer's customer invoice, on the ONE active
 * CASH connection whose payer side names the bill's supplier, past the connection's cut-over, the database writes ONE `payment` message for
 * the issuer per allocation row, built from the payer's own rows. Every other case answers with a named reason and writes nothing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { asAppUser, count } from './intercompany.helpers';
import { mirrorCleanup, wipeConnections } from './mirror.helpers';
import { setLoanClearing } from './loan-clearing.helpers';
import { clearPayments, linkBill, plantBatchRow, plantBill, plantPaid, plantPaymentJournal } from './allocation.helpers';
import {
  acct, cashConnect, clearReceipts, co, connectBC, paymentMessages, paymentSetup, party, sendAlloc, sendPay, U,
} from './payment.helpers';

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

const journals = async () => count(pool, 'SELECT count(*) AS n FROM gl_journal_entries WHERE company_id = ANY($1)', [[co.A, co.B]]);
const setConn = (set: string) => asAppUser(pool, U.ab, co.A, (q) => q.query(`UPDATE intercompany_connections SET ${set} WHERE id = $1`, [conn]), true);

describe('cash applied to a linked bill on the cash connection', () => {
  it('writes one payment message for the issuer, the payload equal to the payer\'s rows, and nothing else', async () => {
    const { bill, invoice, link } = await plantBill(pool, conn);
    const { payment, allocation, journal } = await plantPaid(pool, bill);
    const before = await journals();
    const out = await sendPay(pool, allocation);
    expect(out).toMatchObject({ reason: null, detail: null });
    const rows = await paymentMessages(pool);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: out.message_id, kind: 'payment', status: 'pending', from_company_id: co.B, to_company_id: co.A, connection_id: conn,
      source_doc_type: 'payment_allocation', source_doc_id: allocation, source_journal_entry_id: journal, target_doc_id: null,
    });
    const p = (await pool.query('SELECT payment_number, payment_date::text AS d FROM supplier_payments WHERE id = $1', [payment])).rows[0];
    const b = (await pool.query('SELECT invoice_number, invoice_date::text AS d FROM supplier_invoices WHERE id = $1', [bill])).rows[0];
    expect(rows[0].payload).toEqual({
      version: 1, kind: 'payment', allocationId: allocation, amount: 1150, currency: 'ZAR',
      payment: { id: payment, number: p.payment_number, reference: 'IC alloc ref', date: p.d, method: 'eft' },
      payerDocument: { type: 'supplier_invoice', id: bill, number: b.invoice_number, date: b.d },
      issuerDocument: { type: 'customer_invoice', id: invoice },
      linkId: link,
    });
    expect(await journals()).toBe(before);
    expect(await count(pool, "SELECT count(*) AS n FROM intercompany_messages WHERE kind <> 'payment'")).toBe(0);
  });

  it('a split payment over two bills, and a batch, give one message per allocation row', async () => {
    const one = await plantBill(pool, conn);
    const two = await plantBill(pool, conn);
    const first = await plantPaid(pool, one.bill, { amount: 600 });
    const second = await plantPaid(pool, two.bill, { amount: 550, payment: first.payment });
    for (const a of [first.allocation, second.allocation]) expect((await sendPay(pool, a)).reason).toBeNull();
    const batch = await plantBatchRow(pool, { journal: await plantPaymentJournal(pool, 1150) });
    const member = await plantPaid(pool, (await plantBill(pool, conn)).bill, { batch });
    expect((await sendPay(pool, member.allocation)).reason).toBeNull();
    expect((await paymentMessages(pool)).map((m) => Number(m.payload.amount)).sort()).toEqual([1150, 550, 600]);
  });

  it('is idempotent: a second call and a re-process answer already_sent', async () => {
    const { allocation } = await plantPaid(pool, (await plantBill(pool, conn)).bill);
    expect((await sendPay(pool, allocation)).message_id).toBeTruthy();
    for (let i = 0; i < 2; i += 1) expect(await sendPay(pool, allocation)).toEqual({ message_id: null, reason: 'already_sent', detail: null });
    expect(await paymentMessages(pool)).toHaveLength(1);
  });

  it('a payment dated ON the cut-over and a reconciled one are sent', async () => {
    const { allocation } = await plantPaid(pool, (await plantBill(pool, conn)).bill, { status: 'reconciled', date: '2026-01-01' });
    expect((await sendPay(pool, allocation)).reason).toBeNull();
  });
});

describe('every refusal names its reason and writes nothing', () => {
  type Case = [string, string, () => Promise<{ allocation: string | null }>];
  const bill = (over: Parameters<typeof plantBill>[2] = {}) => plantBill(pool, conn, over);
  const paid = async (over: Parameters<typeof plantPaid>[2] = {}, b: Parameters<typeof plantBill>[2] = {}) => plantPaid(pool, (await bill(b)).bill, over);
  const cases: Case[] = [
    ['a NULL allocation', 'not_found', async () => ({ allocation: null })],
    ['an unknown allocation row', 'not_found', async () => ({ allocation: crypto.randomUUID() })],
    ['a deleted bill', 'not_found', async () => {
      const b = await bill();
      const p = await plantPaid(pool, b.bill);
      await pool.query('UPDATE supplier_invoices SET deleted_at = now() WHERE id = $1', [b.bill]);
      return p;
    }],
    ["the payer's flag off", 'not_enabled', async () => { const p = await paid(); await setLoanClearing(pool, [co.B], false); return p; }],
    ["the payer's flag absent (default off)", 'not_enabled', async () => { const p = await paid(); await setLoanClearing(pool, [co.B], null); return p; }],
    ['a loan connection', 'not_partner_supplier', async () => { const p = await paid(); await setConn("settlement_mode = 'loan'"); return p; }],
    ['a revoked connection', 'not_partner_supplier', async () => { const p = await paid(); await setConn("status = 'revoked'"); return p; }],
    ['a bill of a supplier on no connection', 'not_partner_supplier', async () => {
      const b = await bill();
      const other = crypto.randomUUID();
      await pool.query('INSERT INTO suppliers(id, company_id, name) VALUES ($1, $2, $3)', [other, co.B, `IC other ${other.slice(0, 6)}`]);
      await pool.query('UPDATE supplier_invoices SET supplier_id = $1 WHERE id = $2', [other, b.bill]);
      return plantPaid(pool, b.bill);
    }],
    ['an UNLINKED bill of the partner\'s supplier', 'not_linked', async () => paid({}, { link: false })],
    ['a link pending confirmation', 'not_linked', async () => paid({}, { link: 'pending_confirmation' })],
    ['a connection with no cut-over', 'no_cutover', async () => { const p = await paid(); await setConn('cutover_date = NULL'); return p; }],
    ['a payment before the connection cut-over', 'before_cutover', async () => paid({ date: '2025-12-31' })],
    ['a draft payment', 'not_posted', async () => paid({ status: 'draft' })],
    ['an approved payment', 'not_posted', async () => paid({ status: 'approved' })],
    ['a processed payment with no journal', 'no_journal', async () => paid({ journal: false })],
    ['a payment whose journal was reversed', 'no_journal', async () => paid({ reversed: true })],
    ['a payment whose journal credits the payer\'s loan account', 'through_loan', async () => paid({ leg: acct.bLoan })],
  ];
  it.each(cases)('%s: %s', async (_name, reason, plant) => {
    const { allocation } = await plant();
    const before = await journals();
    expect(await sendPay(pool, allocation)).toEqual({ message_id: null, reason, detail: null });
    expect(await paymentMessages(pool)).toHaveLength(0);
    expect(await journals()).toBe(before);
  });

  it('no session (no company, or no signed-in user) answers no_session; a viewer is forbidden before anything about the row', async () => {
    const { allocation } = await paid();
    const q = await pool.connect();
    try {
      await q.query('BEGIN');
      await q.query('SET LOCAL ROLE app_user');
      expect((await q.query('SELECT * FROM public.intercompany_send_for_payment($1)', [allocation])).rows[0]).toMatchObject({ reason: 'no_session' });
    } finally {
      await q.query('ROLLBACK');
      q.release();
    }
    for (const id of [allocation, crypto.randomUUID()]) expect((await sendPay(pool, id, U.avb)).reason).toBe('forbidden');
    expect(await paymentMessages(pool)).toHaveLength(0);
  });

  it('ambiguous: the supplier on two active cash connections of the payer (forced: the unique side index is dropped in the rolled-back fixture)', async () => {
    const { allocation } = await paid();
    const bc = await connectBC(pool, 'cash');
    const q = await pool.connect();
    try {
      await q.query('BEGIN');
      await q.query('DROP INDEX intercompany_sides_supplier_uq');
      await q.query('ALTER TABLE intercompany_connection_sides DISABLE TRIGGER USER');
      await q.query('UPDATE intercompany_connection_sides SET supplier_id = $1 WHERE connection_id = $2 AND company_id = $3', [party.bSupplier, bc, co.B]);
      await q.query('SET LOCAL ROLE app_user');
      await q.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: U.b })]);
      await q.query("SELECT set_config('app.current_company_id', $1, true)", [co.B]);
      expect((await q.query('SELECT * FROM public.intercompany_send_for_payment($1)', [allocation])).rows[0]).toMatchObject({ message_id: null, reason: 'ambiguous' });
    } finally {
      await q.query('ROLLBACK');
      q.release();
    }
  });

  it('allocation_sent: the row already has an allocation message (a loan-mode send before a mode flip)', async () => {
    await setConn("settlement_mode = 'loan'");
    const { allocation } = await paid();
    expect((await sendAlloc(pool, allocation)).message_id).toBeTruthy();
    await setConn("settlement_mode = 'cash'");
    expect(await sendPay(pool, allocation)).toEqual({ message_id: null, reason: 'allocation_sent', detail: null });
    expect(await count(pool, 'SELECT count(*) AS n FROM intercompany_messages WHERE source_doc_id = $1', [allocation])).toBe(1);
  });

  it('superseded: an ACCEPTED message of the same payment names an allocation row that no longer exists (any bill)', async () => {
    const first = await paid();
    expect((await sendPay(pool, first.allocation)).message_id).toBeTruthy();
    // the fixture accepts it and then deletes its allocation row (the undo gate bypassed): the payment re-applied to a DIFFERENT bill
    await pool.query("ALTER TABLE intercompany_messages DISABLE TRIGGER trg_intercompany_messages_guard");
    await pool.query("UPDATE intercompany_messages SET status = 'accepted' WHERE source_doc_id = $1", [first.allocation]);
    await pool.query('ALTER TABLE intercompany_messages ENABLE ALWAYS TRIGGER trg_intercompany_messages_guard');
    await pool.query('DELETE FROM payment_allocations WHERE id = $1', [first.allocation]);
    const other = await bill();
    const re = (await pool.query('INSERT INTO payment_allocations(payment_id, invoice_id, amount_allocated) VALUES ($1, $2, 1150) RETURNING id', [first.payment, other.bill])).rows[0].id as string;
    expect(await sendPay(pool, re)).toEqual({ message_id: null, reason: 'superseded', detail: null });
    expect(await paymentMessages(pool)).toHaveLength(1);
  });
});

describe('a mirror link counts like a manual one', () => {
  it('sends for a bill whose active link is the mirror\'s', async () => {
    const { bill, invoice } = await plantBill(pool, conn, { link: false });
    await linkBill(pool, conn, invoice, bill, 'active', 'mirror');
    const { allocation } = await plantPaid(pool, bill);
    expect((await sendPay(pool, allocation)).reason).toBeNull();
  });
});
